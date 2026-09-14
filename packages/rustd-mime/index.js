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
class MultipartError extends MimeError { static code = 'ERR_MIME_MULTIPART'; }

function native(fn) {
  try { return fn(); } catch (cause) {
    const msg = String(cause.message ?? cause);
    const colon = msg.indexOf(': ');
    const code = colon >= 0 ? msg.slice(0, colon) : '';
    const text = colon >= 0 ? msg.slice(colon + 2) : msg;
    const ErrorClass = { MediaTypeError, QuotedPrintableError, MimeWordError, MultipartError }[code] ?? MimeError;
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

function fileContentDisposition(fieldname, filename) {
  if (typeof fieldname !== 'string' || typeof filename !== 'string') throw new TypeError('mime: expected string');
  return native(() => binding.fileContentDisposition(fieldname, filename));
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

class MultipartPartWriter {
  constructor(handle, partId) {
    this._handle = handle;
    this._partId = partId;
  }
  write(data) { native(() => this._handle.writePart(this._partId, bytes(data))); }
  end() { native(() => this._handle.endPart(this._partId)); }
}

class MultipartWriter {
  constructor(opts) {
    if (opts != null && typeof opts !== 'object') throw new TypeError('mime: opts must be an object');
    const boundary = opts?.boundary;
    if (boundary !== undefined && typeof boundary !== 'string') {
      throw new TypeError('mime: boundary must be a string');
    }
    this._handle = native(() => new binding.NativeMultipartWriter(boundary));
  }
  setBoundary(boundary) {
    if (typeof boundary !== 'string') throw new TypeError('mime: expected string');
    native(() => this._handle.setBoundary(boundary));
  }
  boundary() { return native(() => this._handle.boundary()); }
  formDataContentType() { return native(() => this._handle.formDataContentType()); }
  createFormField(fieldname) {
    if (typeof fieldname !== 'string') throw new TypeError('mime: expected string');
    const partId = native(() => this._handle.createFormField(fieldname));
    return new MultipartPartWriter(this._handle, partId);
  }
  createFormFile(fieldname, filename) {
    if (typeof fieldname !== 'string' || typeof filename !== 'string') throw new TypeError('mime: expected string');
    const partId = native(() => this._handle.createFormFile(fieldname, filename));
    return new MultipartPartWriter(this._handle, partId);
  }
  createPart(header) {
    const rec = requireMIMEHeader(header);
    const fields = [];
    for (const key of Object.keys(rec)) {
      const values = rec[key];
      if (!Array.isArray(values)) throw new TypeError('mime: MIMEHeader values must be string arrays');
      for (const value of values) {
        if (typeof value !== 'string') throw new TypeError('mime: MIMEHeader values must be strings');
      }
      fields.push({ key, values: values.slice() });
    }
    const partId = native(() => this._handle.createPart(fields));
    return new MultipartPartWriter(this._handle, partId);
  }
  writeField(fieldname, value) {
    if (typeof fieldname !== 'string' || typeof value !== 'string') throw new TypeError('mime: expected string');
    native(() => this._handle.writeField(fieldname, value));
  }
  bytes() { return native(() => this._handle.finish()); }
}

class MultipartPart {
  constructor(data) {
    const header = Object.create(null);
    for (const field of data.header) header[field.key] = field.values;
    this.header = header;
    this._formName = data.formName;
    this._fileName = data.fileName;
    this._body = data.body;
    this._offset = 0;
    this._closed = false;
  }
  formName() { return this._formName; }
  fileName() { return this._fileName; }
  read() {
    if (this._closed) throw new MultipartError('multipart: part is closed');
    const out = this._body.subarray(this._offset);
    this._offset = this._body.length;
    return out;
  }
  readChunk(maxBytes) {
    if (this._closed) throw new MultipartError('multipart: part is closed');
    if (maxBytes !== undefined && (typeof maxBytes !== 'number' || maxBytes < 0 || !Number.isInteger(maxBytes))) {
      throw new TypeError('mime: maxBytes must be a non-negative integer');
    }
    const end = maxBytes === undefined ? this._body.length : Math.min(this._body.length, this._offset + maxBytes);
    const out = this._body.subarray(this._offset, end);
    this._offset = end;
    return out;
  }
  close() {
    this._closed = true;
    this._offset = this._body.length;
  }
}

class MultipartReader {
  constructor(opts) {
    if (opts == null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new TypeError('mime: opts must be an object');
    }
    if (typeof opts.boundary !== 'string') throw new TypeError('mime: boundary must be a string');
    if (opts.maxHeadersPerPart !== undefined && (typeof opts.maxHeadersPerPart !== 'number' || opts.maxHeadersPerPart < 0 || !Number.isInteger(opts.maxHeadersPerPart))) {
      throw new TypeError('mime: maxHeadersPerPart must be a non-negative integer');
    }
    if (opts.maxTotalHeaders !== undefined && (typeof opts.maxTotalHeaders !== 'number' || opts.maxTotalHeaders < 0 || !Number.isInteger(opts.maxTotalHeaders))) {
      throw new TypeError('mime: maxTotalHeaders must be a non-negative integer');
    }
    this._handle = native(() => new binding.NativeMultipartReader(opts.boundary));
  }
  write(chunk) { native(() => this._handle.write(bytes(chunk))); }
  nextPart() {
    const data = native(() => this._handle.nextPart());
    if (data == null) return null;
    return new MultipartPart(data);
  }
  nextRawPart() {
    const data = native(() => this._handle.nextRawPart());
    if (data == null) return null;
    return new MultipartPart(data);
  }
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
  MimeError, MediaTypeError, InvalidMediaParameterError, QuotedPrintableError, MimeWordError, MultipartError,
  parseMediaType, formatMediaType, typeByExtension, extensionsByType, addExtensionType, loadSystemMimeTypes,
  quotedPrintableEncode, quotedPrintableDecode, QuotedPrintableReader, QuotedPrintableWriter,
  encodeWord, MimeWordDecoder,
  canonicalMIMEHeaderKey, mimeHeaderGet, mimeHeaderValues, mimeHeaderSet, mimeHeaderAdd, mimeHeaderDel,
  MultipartWriter, MultipartReader, MultipartPart, fileContentDisposition,
};
