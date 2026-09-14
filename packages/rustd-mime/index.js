'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-mime';
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

class MimeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
}
class MediaTypeError extends MimeError { static code = 'ERR_MIME_MEDIA_TYPE'; }
class InvalidMediaParameterError extends MediaTypeError {
  static code = 'ERR_MIME_INVALID_MEDIA_PARAMETER';
  constructor(message, options) {
    super(message, options);
    this.mediaType = options?.mediaType ?? '';
    this.params = options?.params ?? {};
  }
}
class QuotedPrintableError extends MimeError {
  static code = 'ERR_MIME_QUOTED_PRINTABLE';
  constructor(message, options) {
    super(message, options);
    this.byteOffset = options?.byteOffset;
    this.decoded = options?.decoded;
  }
}
class MimeWordError extends MimeError { static code = 'ERR_MIME_WORD'; }

function native(fn) {
  try { return fn(); } catch (cause) {
    const msg = String(cause.message ?? cause);
    const colon = msg.indexOf(': ');
    const code = colon >= 0 ? msg.slice(0, colon) : '';
    const text = colon >= 0 ? msg.slice(colon + 2) : msg;
    const ErrorClass = { MediaTypeError, QuotedPrintableError, MimeWordError }[code] ?? MimeError;
    throw new ErrorClass(text, { cause });
  }
}

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('mime: expected Uint8Array');
  }
  return value;
}

function paramsObject(list) {
  const params = {};
  for (const item of list) params[item.key] = item.value;
  return params;
}

function paramsList(params) {
  if (params == null) return [];
  if (typeof params !== 'object') throw new TypeError('mime: params must be an object');
  return Object.keys(params).map(key => ({ key, value: String(params[key]) }));
}

function parseMediaType(v) {
  if (typeof v !== 'string') throw new TypeError('mime: expected string');
  const result = native(() => binding.parseMediaType(v));
  const params = paramsObject(result.params);
  if (result.error === 'mime: invalid media parameter') {
    throw new InvalidMediaParameterError(result.error, { mediaType: result.mediaType, params });
  }
  if (result.error) throw new MediaTypeError(result.error);
  return { mediaType: result.mediaType, params };
}

function formatMediaType(t, params) {
  if (typeof t !== 'string') throw new TypeError('mime: expected string');
  return native(() => binding.formatMediaType(t, paramsList(params)));
}

function typeByExtension(ext) {
  if (typeof ext !== 'string') throw new TypeError('mime: expected string');
  return native(() => binding.typeByExtension(ext));
}

function extensionsByType(typ) {
  if (typeof typ !== 'string') throw new TypeError('mime: expected string');
  return native(() => binding.extensionsByType(typ));
}

function addExtensionType(ext, typ) {
  if (typeof ext !== 'string' || typeof typ !== 'string') throw new TypeError('mime: expected string');
  native(() => binding.addExtensionType(ext, typ));
}

function loadSystemMimeTypes(paths) {
  if (paths !== undefined && !Array.isArray(paths)) throw new TypeError('mime: paths must be an array');
  return native(() => binding.loadSystemMimeTypes(paths));
}

function quotedPrintableEncode(data, opts) {
  const binary = opts?.binary === true;
  if (opts != null && (typeof opts !== 'object' || (opts.binary !== undefined && typeof opts.binary !== 'boolean'))) {
    throw new TypeError('mime: binary must be a boolean');
  }
  return native(() => binding.qpEncode(bytes(data), binary));
}

function quotedPrintableDecode(data) {
  const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : bytes(data);
  const result = native(() => binding.qpDecode(input));
  if (result.error) {
    throw new QuotedPrintableError(result.error, { decoded: result.data });
  }
  return result.data;
}

class QuotedPrintableReader {
  constructor(input) {
    this._handle = native(() => new binding.NativeQpReader(bytes(input)));
    this._done = false;
  }
  read(maxBytes) {
    if (maxBytes !== undefined && (typeof maxBytes !== 'number' || maxBytes < 0 || !Number.isInteger(maxBytes))) {
      throw new TypeError('mime: maxBytes must be a non-negative integer');
    }
    return native(() => this._handle.read(maxBytes));
  }
  end() { native(() => this._handle.end()); this._done = true; }
}

class QuotedPrintableWriter {
  constructor(opts) {
    const binary = opts?.binary === true;
    if (opts != null && (typeof opts !== 'object' || (opts.binary !== undefined && typeof opts.binary !== 'boolean'))) {
      throw new TypeError('mime: binary must be a boolean');
    }
    this._handle = native(() => new binding.NativeQpWriter(binary));
  }
  write(data) { native(() => this._handle.write(bytes(data))); }
  finish() { return native(() => this._handle.finish()); }
}

function canonicalMIMEHeaderKey(s) {
  if (typeof s !== 'string') throw new TypeError('mime: expected string');
  return native(() => binding.canonicalMimeHeaderKey(s));
}

function asMIMEHeader(header) {
  if (header == null) return null;
  if (typeof header !== 'object' || Array.isArray(header)) {
    throw new TypeError('mime: MIMEHeader must be an object');
  }
  return header;
}

function mimeHeaderGet(header, key) {
  if (typeof key !== 'string') throw new TypeError('mime: expected string');
  const rec = asMIMEHeader(header);
  if (rec == null) return '';
  const values = rec[canonicalMIMEHeaderKey(key)];
  return values && values.length ? String(values[0]) : '';
}

function mimeHeaderValues(header, key) {
  if (typeof key !== 'string') throw new TypeError('mime: expected string');
  const rec = asMIMEHeader(header);
  if (rec == null) return [];
  const values = rec[canonicalMIMEHeaderKey(key)];
  return values ? values.map(String) : [];
}

function requireMIMEHeader(header) {
  const rec = asMIMEHeader(header);
  if (rec == null) throw new TypeError('mime: MIMEHeader must be an object');
  return rec;
}

function mimeHeaderSet(header, key, value) {
  if (typeof key !== 'string' || typeof value !== 'string') throw new TypeError('mime: expected string');
  requireMIMEHeader(header)[canonicalMIMEHeaderKey(key)] = [value];
}

function mimeHeaderAdd(header, key, value) {
  if (typeof key !== 'string' || typeof value !== 'string') throw new TypeError('mime: expected string');
  const rec = requireMIMEHeader(header);
  const canon = canonicalMIMEHeaderKey(key);
  if (Object.prototype.hasOwnProperty.call(rec, canon)) rec[canon].push(value);
  else rec[canon] = [value];
}

function mimeHeaderDel(header, key) {
  if (typeof key !== 'string') throw new TypeError('mime: expected string');
  delete requireMIMEHeader(header)[canonicalMIMEHeaderKey(key)];
}

function encodeWord(charset, s, enc) {
  if (typeof charset !== 'string' || typeof s !== 'string') throw new TypeError('mime: expected string');
  if (enc !== 'b' && enc !== 'q') throw new TypeError('mime: encoding must be b or q');
  return native(() => binding.encodeWord(charset, s, enc));
}

function defaultCharsetReader(charset, input) {
  const text = new TextDecoder(charset).decode(input);
  return new TextEncoder().encode(text);
}

function applyPart(part, charsetReader) {
  if (part.text != null) return part.text;
  const converted = charsetReader(part.charset, part.content);
  return new TextDecoder('utf-8').decode(converted);
}

class MimeWordDecoder {
  constructor(opts) {
    this.charsetReader = opts?.charsetReader ?? defaultCharsetReader;
    if (typeof this.charsetReader !== 'function') {
      throw new TypeError('mime: charsetReader must be a function');
    }
  }
  decode(word) {
    if (typeof word !== 'string') throw new TypeError('mime: expected string');
    const part = native(() => binding.decodeWord(word));
    return applyPart(part, this.charsetReader);
  }
  decodeHeader(header) {
    if (typeof header !== 'string') throw new TypeError('mime: expected string');
    const parts = native(() => binding.decodeHeaderParts(header));
    return parts.map(part => applyPart(part, this.charsetReader)).join('');
  }
}

module.exports = {
  MimeError, MediaTypeError, InvalidMediaParameterError, QuotedPrintableError, MimeWordError,
  parseMediaType, formatMediaType, typeByExtension, extensionsByType, addExtensionType, loadSystemMimeTypes,
  quotedPrintableEncode, quotedPrintableDecode, QuotedPrintableReader, QuotedPrintableWriter,
  encodeWord, MimeWordDecoder,
  canonicalMIMEHeaderKey, mimeHeaderGet, mimeHeaderValues, mimeHeaderSet, mimeHeaderAdd, mimeHeaderDel,
};
