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
    return fn();
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

module.exports = {
  CsvReader,
  CsvWriter,
  CsvParseError,
  CsvEncodingError,
  pemDecode,
  pemDecodeAll,
  pemEncode,
  PemEncodeError,
};
