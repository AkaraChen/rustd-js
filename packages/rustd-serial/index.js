'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-serial';
let platform = `${process.platform}-${process.arch}`;
if (process.platform === 'linux') {
  if (!process.report.getReport().header.glibcVersionRuntime) {
    throw new Error(`${name}: Linux musl is not supported`);
  }
  platform += '-gnu';
} else if (process.platform === 'win32') platform += '-msvc';
if (!['darwin-arm64', 'darwin-x64', 'linux-x64-gnu', 'linux-arm64-gnu', 'win32-x64-msvc'].includes(platform)) {
  throw new Error(`${name}: unsupported platform ${platform}`);
}
const local = join(__dirname, `${name}.${platform}.node`);
const binding = existsSync(local) ? require(local) : require(`${name}-${platform}`);

class CsvParseError extends Error {
  constructor(message, startLine, line, column, options) {
    super(message, options);
    this.name = 'CsvParseError';
    this.code = 'CSV_PARSE';
    this.startLine = startLine;
    this.line = line;
    this.column = column;
  }
}

class CsvEncodingError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CsvEncodingError';
    this.code = 'CSV_ENCODING';
  }
}

class PemEncodeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PemEncodeError';
    this.code = 'PEM_ENCODE';
  }
}

class Asn1SyntaxError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'Asn1SyntaxError';
    this.code = 'ASN1_SYNTAX';
  }
}

class Asn1StructuralError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'Asn1StructuralError';
    this.code = 'ASN1_STRUCTURAL';
  }
}

class XmlSyntaxError extends Error {
  constructor(message, line, options) {
    super(message, options);
    this.name = 'XmlSyntaxError';
    this.code = 'XML_SYNTAX';
    this.line = line;
  }
}

class XmlUnsupportedTypeError extends Error {
  constructor(message, typeName, options) {
    super(message, options);
    this.name = 'XmlUnsupportedTypeError';
    this.code = 'XML_UNSUPPORTED';
    this.typeName = typeName;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('serial: expected Uint8Array');
  }
  return value;
}

function codePoint(name, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new TypeError(`serial: ${name} must be a single-character string`);
  }
  const chars = [...value];
  if (chars.length !== 1) {
    throw new TypeError(`serial: ${name} must be a single-character string`);
  }
  return chars[0].codePointAt(0);
}

function validDelim(cp) {
  return cp !== 0 && cp !== 0x22 && cp !== 0x0d && cp !== 0x0a && cp !== 0xfffd;
}

function native(fn) {
  try {
    const out = fn();
    if (out instanceof Error) throw out;
    return out;
  } catch (cause) {
    const text = String(cause.message ?? cause);
    if (text.startsWith('RangeError:')) {
      throw new RangeError(text.slice('RangeError:'.length), { cause });
    }
    const parts = text.split(':');
    if (parts[0] === 'CsvParseError') {
      const startLine = Number(parts[1]);
      const line = Number(parts[2]);
      const column = Number(parts[3]);
      const kind = parts[4];
      const inner = parts.slice(5).join(':');
      if (kind === 'InvalidDelim') {
        throw new TypeError(inner, { cause });
      }
      let message;
      if (kind === 'FieldCount') {
        message = `record on line ${line}: ${inner}`;
      } else if (startLine !== line) {
        message = `record on line ${startLine}; parse error on line ${line}, column ${column}: ${inner}`;
      } else {
        message = `parse error on line ${line}, column ${column}: ${inner}`;
      }
      throw new CsvParseError(message, startLine, line, column, { cause: new Error(inner, { cause }) });
    }
    if (text.startsWith('PemEncodeError:')) {
      throw new PemEncodeError(text.slice('PemEncodeError:'.length), { cause });
    }
    if (text.startsWith('Asn1SyntaxError:')) {
      throw new Asn1SyntaxError(`asn1: syntax error: ${text.slice('Asn1SyntaxError:'.length)}`, { cause });
    }
    if (text.startsWith('Asn1StructuralError:')) {
      throw new Asn1StructuralError(`asn1: structure error: ${text.slice('Asn1StructuralError:'.length)}`, { cause });
    }
    if (text.startsWith('XmlSyntaxError:')) {
      const rest = text.slice('XmlSyntaxError:'.length);
      const colon = rest.indexOf(':');
      const line = Number(colon < 0 ? rest : rest.slice(0, colon));
      const msg = colon < 0 ? rest : rest.slice(colon + 1);
      throw new XmlSyntaxError(`XML syntax error on line ${line}: ${msg}`, line, { cause });
    }
    if (text.startsWith('XmlUnsupportedTypeError:')) {
      const typeName = text.slice('XmlUnsupportedTypeError:'.length);
      throw new XmlUnsupportedTypeError(`xml: unsupported type: ${typeName}`, typeName, { cause });
    }
    if (text.startsWith('XmlError:')) {
      throw new Error(text.slice('XmlError:'.length), { cause });
    }
    throw cause;
  }
}

function headerMap(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('serial: PEM headers must be a string map');
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== 'string') {
      throw new TypeError('serial: PEM header values must be strings');
    }
    out[key] = val;
  }
  return out;
}

function pemDecode(data) {
  const row = binding.pemDecode(bytes(data));
  if (!row) return null;
  const block = { type: row.type, bytes: row.bytes };
  if (row.headers && Object.keys(row.headers).length > 0) block.headers = row.headers;
  return { block, rest: row.rest };
}

function pemDecodeAll(data) {
  const blocks = [];
  let rest = bytes(data);
  for (;;) {
    const found = pemDecode(rest);
    if (!found) return blocks;
    blocks.push(found.block);
    rest = found.rest;
  }
}

function pemEncode(block) {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    throw new TypeError('serial: pemEncode expects a PemBlock');
  }
  if (typeof block.type !== 'string') {
    throw new TypeError('serial: PEM type must be a string');
  }
  return native(() => binding.pemEncode(block.type, headerMap(block.headers), bytes(block.bytes)));
}

function fieldToBytes(field) {
  if (typeof field === 'string') return new TextEncoder().encode(field);
  return bytes(field);
}

class CsvReader {
  constructor(input, opts) {
    const options = opts === undefined ? {} : opts;
    if (options === null || typeof options !== 'object') {
      throw new TypeError('serial: CsvReader options must be an object');
    }
    const comma = codePoint('comma', options.comma, 0x2c);
    const comment = options.comment === undefined ? 0 : codePoint('comment', options.comment);
    if (!validDelim(comma) || (comment !== 0 && (!validDelim(comment) || comment === comma))) {
      throw new TypeError('csv: invalid field or comment delimiter');
    }
    let fieldsPerRecord = 0;
    if (options.fieldsPerRecord !== undefined) {
      if (typeof options.fieldsPerRecord !== 'number' || !Number.isInteger(options.fieldsPerRecord)) {
        throw new TypeError('serial: fieldsPerRecord must be an integer');
      }
      fieldsPerRecord = options.fieldsPerRecord;
    }
    this._handle = new binding.NativeCsvReader(
      bytes(input),
      comma,
      comment,
      fieldsPerRecord,
      Boolean(options.lazyQuotes),
      Boolean(options.trimLeadingSpace),
    );
  }

  read() {
    const row = native(() => this._handle.read());
    if (row == null) return null;
    try {
      return row.fields.map((field) => utf8.decode(field));
    } catch (cause) {
      throw new CsvEncodingError('csv: field is not valid UTF-8', { cause });
    }
  }

  readBytes() {
    const row = native(() => this._handle.read());
    if (row == null) return null;
    return row.fields;
  }

  readAll() {
    const records = [];
    for (;;) {
      const row = this.read();
      if (row == null) return records;
      records.push(row);
    }
  }

  fieldPos(field) {
    if (typeof field !== 'number' || !Number.isInteger(field)) {
      throw new TypeError('serial: fieldPos index must be an integer');
    }
    return native(() => this._handle.fieldPos(field));
  }

  inputOffset() {
    const n = this._handle.inputOffset();
    return typeof n === 'bigint' ? Number(n) : n;
  }
}

class CsvWriter {
  constructor(opts) {
    const options = opts === undefined ? {} : opts;
    if (options === null || typeof options !== 'object') {
      throw new TypeError('serial: CsvWriter options must be an object');
    }
    const comma = codePoint('comma', options.comma, 0x2c);
    if (!validDelim(comma)) {
      throw new TypeError('csv: invalid field or comment delimiter');
    }
    this._handle = new binding.NativeCsvWriter(comma, Boolean(options.useCRLF));
    this._error = null;
  }

  write(record) {
    if (!Array.isArray(record)) {
      throw new TypeError('serial: CSV record must be an array');
    }
    try {
      native(() => this._handle.write(record.map(fieldToBytes)));
      this._error = null;
    } catch (err) {
      this._error = err;
      throw err;
    }
  }

  writeAll(records) {
    if (!Array.isArray(records)) {
      throw new TypeError('serial: writeAll expects an array of records');
    }
    for (const record of records) this.write(record);
  }

  bytes() {
    return this._handle.bytes();
  }

  error() {
    const text = this._handle.errorText();
    if (this._error) return this._error;
    if (text) return new TypeError(text);
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function hexOf(data) {
  return Buffer.from(data).toString('hex');
}

function toIr(schema, value) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema) || typeof schema.kind !== 'string') {
    throw new TypeError('serial: Asn1Schema must be an object with kind');
  }
  const kind = schema.kind;
  if (kind === 'optional') {
    if (value === undefined || value === null) return null;
    return toIr(schema.inner, value);
  }
  if (kind === 'explicit' || kind === 'implicit') {
    return toIr(schema.inner, value);
  }
  if (value === undefined) {
    throw new TypeError(`serial: missing ASN.1 value for kind ${kind}`);
  }
  switch (kind) {
    case 'bool':
      if (typeof value !== 'boolean') throw new TypeError('serial: expected boolean');
      return value;
    case 'int':
    case 'enumerated':
      if (typeof value === 'bigint') return { $i: value.toString() };
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      throw new TypeError('serial: expected integer');
    case 'bigint':
      if (typeof value === 'bigint') return { $i: value.toString() };
      if (typeof value === 'number' && Number.isInteger(value)) return { $i: String(value) };
      throw new TypeError('serial: expected bigint');
    case 'bitstring':
      if (!isPlainObject(value) || !ArrayBuffer.isView(value.bytes)) {
        throw new TypeError('serial: expected Asn1BitString');
      }
      if (typeof value.bitLength !== 'number' || !Number.isInteger(value.bitLength)) {
        throw new TypeError('serial: bitLength must be an integer');
      }
      return { $bits: hexOf(bytes(value.bytes)), bitLength: value.bitLength };
    case 'octetstring':
      return { $b: hexOf(bytes(value)) };
    case 'oid':
      if (!Array.isArray(value) || value.some((n) => typeof n !== 'number' || !Number.isInteger(n))) {
        throw new TypeError('serial: oid must be an integer array');
      }
      return value;
    case 'null':
      return null;
    case 'utf8':
    case 'ia5':
    case 'printable':
    case 'numeric':
    case 'bmp':
      if (typeof value !== 'string') throw new TypeError('serial: expected string');
      return value;
    case 'utctime':
    case 'generalizedtime':
      if (value instanceof Date) return { $t: value.getTime() };
      if (typeof value === 'number' && Number.isFinite(value)) return { $t: value };
      throw new TypeError('serial: expected Date');
    case 'raw':
      if (!isPlainObject(value)) throw new TypeError('serial: expected Asn1RawValue');
      return {
        $raw: {
          class: value.class ?? 0,
          tag: value.tag,
          isCompound: Boolean(value.isCompound),
          bytes: hexOf(bytes(value.bytes ?? new Uint8Array())),
          fullBytes: value.fullBytes ? hexOf(bytes(value.fullBytes)) : '',
        },
      };
    case 'sequence':
    case 'set': {
      const fields = Array.isArray(schema.fields) ? schema.fields : [];
      const named = fields.some((f) => f && typeof f.name === 'string');
      if (named) {
        if (!isPlainObject(value)) throw new TypeError('serial: expected sequence object');
        const out = {};
        for (const field of fields) {
          const child = value[field.name];
          out[field.name] = child === undefined || child === null ? null : toIr(field.schema, child);
        }
        return out;
      }
      if (!Array.isArray(value)) throw new TypeError('serial: expected sequence array');
      return fields.map((field, i) => (value[i] === undefined || value[i] === null ? null : toIr(field.schema, value[i])));
    }
    case 'sequenceof':
    case 'setof':
      if (!Array.isArray(value)) throw new TypeError('serial: expected array');
      return value.map((item) => toIr(schema.inner, item));
    default:
      throw new TypeError(`serial: unknown Asn1Schema kind ${kind}`);
  }
}

function fromIr(value) {
  if (Array.isArray(value)) return value.map(fromIr);
  if (!value || typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, '$b')) return Uint8Array.from(Buffer.from(value.$b, 'hex'));
  if (Object.prototype.hasOwnProperty.call(value, '$i')) return BigInt(value.$i);
  if (Object.prototype.hasOwnProperty.call(value, '$t')) return new Date(value.$t);
  if (Object.prototype.hasOwnProperty.call(value, '$bits')) {
    return { bytes: Uint8Array.from(Buffer.from(value.$bits, 'hex')), bitLength: value.bitLength };
  }
  if (Object.prototype.hasOwnProperty.call(value, '$raw')) {
    const raw = value.$raw;
    return {
      class: raw.class,
      tag: raw.tag,
      isCompound: raw.isCompound,
      bytes: Uint8Array.from(Buffer.from(raw.bytes ?? '', 'hex')),
      fullBytes: Uint8Array.from(Buffer.from(raw.fullBytes ?? '', 'hex')),
    };
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) out[key] = fromIr(val);
  return out;
}

function schemaJson(schema) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('serial: Asn1Schema must be an object with kind');
  }
  return JSON.stringify(schema);
}

function asn1Marshal(value, schema, params) {
  if (params !== undefined && typeof params !== 'string') {
    throw new TypeError('serial: params must be a string');
  }
  const ir = toIr(schema, value);
  return native(() => binding.asn1Marshal(schemaJson(schema), JSON.stringify(ir), params));
}

function asn1Unmarshal(input, schema, params) {
  if (params !== undefined && typeof params !== 'string') {
    throw new TypeError('serial: params must be a string');
  }
  const row = native(() => binding.asn1Unmarshal(bytes(input), schemaJson(schema), params));
  return { value: fromIr(JSON.parse(row.valueJson)), rest: row.rest };
}

function xmlBytes(input) {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  return bytes(input);
}

function sniffXmlEncoding(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  const head = Buffer.from(buf.subarray(0, 512)).toString('latin1');
  const match = /encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  return match ? match[1] : '';
}

function transcodeXml(input, charsetReader) {
  const raw = xmlBytes(input);
  const enc = sniffXmlEncoding(raw);
  if (!enc || enc.toLowerCase() === 'utf-8' || enc.toLowerCase() === 'utf8') return raw;
  if (typeof charsetReader === 'function') {
    const out = charsetReader(enc, raw);
    if (out == null) throw new Error(`xml: opening charset ${JSON.stringify(enc)}: nil reader`);
    return xmlBytes(out);
  }
  try {
    return new TextEncoder().encode(new TextDecoder(enc).decode(raw));
  } catch (cause) {
    throw new Error(`xml: encoding ${JSON.stringify(enc)} declared but Decoder.CharsetReader is nil`, { cause });
  }
}

function parseXmlToken(json) {
  if (json == null) return null;
  const tok = JSON.parse(json);
  if (tok.type === 'procinst') {
    tok.inst = Uint8Array.from(Buffer.from(tok.instHex ?? '', 'hex'));
    delete tok.instHex;
  }
  return tok;
}

function xmlTokenJson(token) {
  if (token == null || typeof token !== 'object') {
    throw new TypeError('serial: XmlToken must be an object');
  }
  const out = { ...token };
  if (token.inst instanceof Uint8Array) {
    out.instHex = hexOf(token.inst);
    delete out.inst;
  }
  return JSON.stringify(out);
}

function xmlValueIr(value) {
  if (value instanceof Date) return { $t: value.getTime() };
  if (value instanceof Uint8Array) return { $b: hexOf(value) };
  if (typeof value === 'bigint') return { $i: value.toString() };
  if (Array.isArray(value)) return value.map(xmlValueIr);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = xmlValueIr(v);
    return out;
  }
  return value;
}

function xmlFromIr(value) {
  if (Array.isArray(value)) return value.map(xmlFromIr);
  if (!value || typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, '$b')) return Uint8Array.from(Buffer.from(value.$b, 'hex'));
  if (Object.prototype.hasOwnProperty.call(value, '$i')) return BigInt(value.$i);
  if (Object.prototype.hasOwnProperty.call(value, '$t')) return new Date(value.$t);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = xmlFromIr(v);
  return out;
}

const HTML_ENTITY = Object.freeze(JSON.parse(binding.xmlHtmlEntity()));
const HTML_AUTO_CLOSE = Object.freeze(JSON.parse(binding.xmlHtmlAutoClose()));
const XML_HEADER = binding.xmlHeaderText();

function getHtmlEntity() {
  return { ...HTML_ENTITY };
}

function getHtmlAutoClose() {
  return HTML_AUTO_CLOSE.slice();
}

class XmlDecoder {
  constructor(input, opts) {
    const options = opts === undefined ? {} : opts;
    if (options === null || typeof options !== 'object') {
      throw new TypeError('serial: XmlDecoder options must be an object');
    }
    const data = transcodeXml(input, options.charsetReader);
    const autoClose = Array.isArray(options.autoClose) ? options.autoClose.map(String) : [];
    const entity = options.entity && typeof options.entity === 'object' ? options.entity : {};
    this._handle = new binding.NativeXmlDecoder(
      data,
      options.strict !== false,
      autoClose,
      JSON.stringify(entity),
      typeof options.defaultSpace === 'string' ? options.defaultSpace : '',
      true,
    );
  }

  token() {
    return parseXmlToken(native(() => this._handle.token()));
  }

  rawToken() {
    return parseXmlToken(native(() => this._handle.rawToken()));
  }

  decode(schema, opts) {
    if (schema == null || typeof schema !== 'object') {
      throw new TypeError('serial: XmlSchema must be an object');
    }
    const start = opts && opts.start ? xmlTokenJson(opts.start) : undefined;
    const json = native(() => this._handle.decode(JSON.stringify(schema), start));
    return xmlFromIr(JSON.parse(json));
  }

  skip() {
    native(() => this._handle.skip());
  }

  inputOffset() {
    const n = this._handle.inputOffset();
    return typeof n === 'bigint' ? Number(n) : n;
  }

  inputPos() {
    const p = this._handle.inputPos();
    return [p.line, p.column];
  }
}

class XmlEncoder {
  constructor(opts) {
    const options = opts === undefined ? {} : opts;
    if (options === null || typeof options !== 'object') {
      throw new TypeError('serial: XmlEncoder options must be an object');
    }
    let prefix = '';
    let indent = '';
    if (typeof options.indent === 'string') indent = options.indent;
    else if (options.indent && typeof options.indent === 'object') {
      prefix = options.indent.prefix ?? '';
      indent = options.indent.indent ?? '';
    }
    this._handle = new binding.NativeXmlEncoder(prefix, indent);
  }

  encodeToken(token) {
    native(() => this._handle.encodeToken(xmlTokenJson(token)));
  }

  encode(value, schema) {
    if (schema == null || typeof schema !== 'object') {
      throw new TypeError('serial: XmlSchema must be an object');
    }
    native(() => this._handle.encode(JSON.stringify(schema), JSON.stringify(xmlValueIr(value))));
  }

  flush() {
    this._handle.flush();
  }

  bytes() {
    return this._handle.bytes();
  }
}

function xmlMarshal(value, schema) {
  if (schema == null || typeof schema !== 'object') {
    throw new TypeError('serial: XmlSchema must be an object');
  }
  return native(() => binding.xmlMarshal(JSON.stringify(schema), JSON.stringify(xmlValueIr(value)), '', ''));
}

function xmlMarshalIndent(value, schema, prefix, indent) {
  if (schema == null || typeof schema !== 'object') {
    throw new TypeError('serial: XmlSchema must be an object');
  }
  if (typeof prefix !== 'string' || typeof indent !== 'string') {
    throw new TypeError('serial: prefix and indent must be strings');
  }
  return native(() => binding.xmlMarshal(JSON.stringify(schema), JSON.stringify(xmlValueIr(value)), prefix, indent));
}

function xmlUnmarshal(input, schema) {
  if (schema == null || typeof schema !== 'object') {
    throw new TypeError('serial: XmlSchema must be an object');
  }
  const json = native(() => binding.xmlUnmarshal(transcodeXml(input), JSON.stringify(schema)));
  return xmlFromIr(JSON.parse(json));
}

function xmlEscape(text) {
  return binding.xmlEscape(bytes(text));
}

module.exports = {
  CsvReader,
  CsvWriter,
  CsvParseError,
  CsvEncodingError,
  pemDecode,
  pemDecodeAll,
  pemEncode,
  PemEncodeError,
  asn1Marshal,
  asn1Unmarshal,
  Asn1SyntaxError,
  Asn1StructuralError,
  XmlDecoder,
  XmlEncoder,
  xmlMarshal,
  xmlMarshalIndent,
  xmlUnmarshal,
  xmlEscape,
  XML_HEADER,
  HTML_ENTITY,
  HTML_AUTO_CLOSE,
  getHtmlEntity,
  getHtmlAutoClose,
  XmlSyntaxError,
  XmlUnsupportedTypeError,
};
