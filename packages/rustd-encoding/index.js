'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { endianness } = require('node:os');
const name = 'rustd-encoding';
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

class EncodingError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
  static code = 'ERR_ENCODING';
}
class CorruptInputError extends EncodingError {
  static code = 'ERR_ENCODING_CORRUPT_INPUT';
  constructor(message, byteIndex, options) {
    super(message, options);
    this.byteIndex = byteIndex;
  }
}
class InvalidByteError extends EncodingError {
  static code = 'ERR_ENCODING_INVALID_BYTE';
  constructor(message, byte, options) {
    super(message, options);
    this.byte = byte;
  }
}
class HexLengthError extends EncodingError { static code = 'ERR_ENCODING_HEX_LENGTH'; }
class BufferTooShortError extends EncodingError { static code = 'ERR_ENCODING_BUFFER_TOO_SHORT'; }
class VarintOverflowError extends EncodingError { static code = 'ERR_ENCODING_VARINT_OVERFLOW'; }
class GobTypeError extends EncodingError {
  static code = 'ERR_ENCODING_GOB_TYPE';
  constructor(message, typeName, options) {
    super(message, options);
    this.typeName = typeName;
  }
}

const errors = {
  EncodingError, CorruptInputError, InvalidByteError, HexLengthError,
  BufferTooShortError, VarintOverflowError, GobTypeError,
};

function native(fn) {
  try { return fn(); } catch (cause) {
    const msg = String(cause.message ?? cause);
    const colon = msg.indexOf(':');
    const kind = colon === -1 ? msg : msg.slice(0, colon);
    const rest = colon === -1 ? '' : msg.slice(colon + 1);
    if (kind === 'CorruptInputError') {
      throw new CorruptInputError(`encoding: corrupt input at byte ${rest}`, Number(rest), { cause });
    }
    if (kind === 'InvalidByteError') {
      throw new InvalidByteError(`encoding/hex: invalid byte: ${rest}`, Number(rest), { cause });
    }
    if (kind === 'HexLengthError') throw new HexLengthError('encoding/hex: odd length hex string', { cause });
    if (kind === 'BufferTooShortError') throw new BufferTooShortError('encoding/binary: insufficient data', { cause });
    if (kind === 'VarintOverflowError') throw new VarintOverflowError('encoding/binary: varint overflows a 64-bit integer', { cause });
    if (kind === 'GobTypeError') throw new GobTypeError(rest || 'encoding/gob: type error', rest, { cause });
    throw new EncodingError(rest || msg, { cause });
  }
}

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('encoding: expected Uint8Array');
  }
  return value;
}
function uint(n) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new TypeError('encoding: expected unsigned 32-bit length');
  }
  return n;
}
function textBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return bytes(value);
}
function padCode(padding) {
  if (padding === null || padding === undefined) return -1;
  if (typeof padding !== 'string') throw new TypeError('encoding: padding must be a string or null');
  const b = Buffer.from(padding, 'utf8');
  if (b.length !== 1) throw new EncodingError('encoding: padding must be a single byte');
  return b[0];
}
function append(dst, extra) {
  const prefix = bytes(dst);
  const out = new Uint8Array(prefix.length + extra.length);
  out.set(prefix);
  out.set(extra, prefix.length);
  return out;
}

class RadixEncoding {
  constructor(kind, alphabet, padding, strict) {
    const expected = kind === 'b64' ? 64 : 32;
    if (typeof alphabet !== 'string' || Buffer.byteLength(alphabet) !== expected) {
      throw new EncodingError(`encoding: alphabet must be ${expected} bytes`);
    }
    this.kind = kind;
    this.alphabet = alphabet;
    this.padding = padding === undefined ? '=' : padding;
    this.pad = padCode(this.padding);
    this._strict = strict === true;
    this._fast = -1;
    if (kind === 'b64' && this.pad === 61 || kind === 'b64' && this.pad === -1) {
      const std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const url = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      if (alphabet === std) this._fast = this.pad === 61 ? 0 : 2;
      else if (alphabet === url) this._fast = this.pad === 61 ? 1 : 3;
    }
  }
  encode(src) {
    const input = bytes(src);
    if (this._fast >= 0) {
      const n = this.encodedLen(input.length);
      const out = Buffer.allocUnsafe(n);
      const written = native(() => binding.base64EncodeInto(this._fast, input, out));
      return written === n ? out : out.subarray(0, written);
    }
    return native(() => (this.kind === 'b64' ? binding.base64Encode : binding.base32Encode)(this.alphabet, this.pad, input));
  }
  encodeToString(src) {
    const input = bytes(src);
    if (this._fast >= 0) return native(() => binding.base64EncodeFastString(this._fast, input));
    if (this.kind === 'b64') return native(() => binding.base64EncodeToString(this.alphabet, this.pad, input));
    return Buffer.from(this.encode(src)).toString('ascii');
  }
  decode(src) {
    if (this.kind === 'b64' && this._fast >= 0 && !this._strict) {
      const input = typeof src === 'string' ? Buffer.from(src, 'latin1') : bytes(src);
      const n = this.decodedLen(input.length);
      const out = Buffer.allocUnsafe(n);
      const written = native(() => binding.base64DecodeInto(this._fast, input, out));
      return written === n ? out : out.subarray(0, written);
    }
    return native(() => this.kind === 'b64'
      ? binding.base64Decode(this.alphabet, this.pad, this._strict, textBytes(src))
      : binding.base32Decode(this.alphabet, this.pad, textBytes(src)));
  }
  decodeString(s) {
    if (typeof s !== 'string') throw new TypeError('encoding: expected string');
    return this.decode(s);
  }
  appendEncode(dst, src) { return append(dst, this.encode(src)); }
  appendDecode(dst, src) { return append(dst, this.decode(src)); }
  encodedLen(n) {
    n = uint(n);
    if (this.kind === 'b64') return this.pad === -1 ? (n / 3 | 0) * 4 + ((n % 3 * 8 + 5) / 6 | 0) : ((n + 2) / 3 | 0) * 4;
    return this.pad === -1 ? (n / 5 | 0) * 8 + ((n % 5 * 8 + 4) / 5 | 0) : ((n + 4) / 5 | 0) * 8;
  }
  decodedLen(n) {
    n = uint(n);
    if (this.kind === 'b64') return this.pad === -1 ? (n / 4 | 0) * 3 + ((n % 4) * 6 / 8 | 0) : (n / 4 | 0) * 3;
    return this.pad === -1 ? (n / 8 | 0) * 5 + ((n % 8) * 5 / 8 | 0) : (n / 8 | 0) * 5;
  }
}

class Base64Encoding extends RadixEncoding {
  constructor(alphabet, opts = {}) {
    if (opts !== undefined && (opts === null || typeof opts !== 'object')) {
      throw new TypeError('encoding: options must be an object');
    }
    super('b64', alphabet, opts.padding === undefined ? '=' : opts.padding, opts.strict === true);
  }
  withPadding(next) { return new Base64Encoding(this.alphabet, { padding: next, strict: this._strict }); }
  strict() { return new Base64Encoding(this.alphabet, { padding: this.padding, strict: true }); }
  static Std = new Base64Encoding('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
  static URL = new Base64Encoding('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');
  static RawStd = new Base64Encoding('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', { padding: null });
  static RawURL = new Base64Encoding('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', { padding: null });
}

class Base32Encoding extends RadixEncoding {
  constructor(alphabet, opts = {}) {
    if (opts !== undefined && (opts === null || typeof opts !== 'object')) {
      throw new TypeError('encoding: options must be an object');
    }
    super('b32', alphabet, opts.padding === undefined ? '=' : opts.padding, false);
  }
  withPadding(next) { return new Base32Encoding(this.alphabet, { padding: next }); }
  static Std = new Base32Encoding('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
  static Hex = new Base32Encoding('0123456789ABCDEFGHIJKLMNOPQRSTUV');
  static RawStd = new Base32Encoding('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', { padding: null });
  static RawHex = new Base32Encoding('0123456789ABCDEFGHIJKLMNOPQRSTUV', { padding: null });
}

function hexEncode(src) { return Buffer.from(native(() => binding.hexEncodeBytes(bytes(src)))).toString('ascii'); }
function hexDecode(s) {
  if (typeof s !== 'string') throw new TypeError('encoding: expected string');
  return native(() => binding.hexDecodeBytes(Buffer.from(s, 'utf8')));
}
function hexAppendEncode(dst, src) { return append(dst, native(() => binding.hexEncodeBytes(bytes(src)))); }
function hexAppendDecode(dst, src) { return append(dst, native(() => binding.hexDecodeBytes(textBytes(src)))); }
function hexEncodedLen(n) { return uint(n) * 2; }
function hexDecodedLen(n) { return uint(n) >> 1; }

function toChar(b) { return b < 32 || b > 126 ? 0x2e : b; }

function hexDumper(onLine) {
  if (typeof onLine !== 'function') throw new TypeError('encoding: onLine must be a function');
  let used = 0, n = 0, closed = false, pending = '';
  const right = new Uint8Array(18);
  const emit = chunk => {
    pending += chunk;
    let idx;
    while ((idx = pending.indexOf('\n')) !== -1) {
      onLine(pending.slice(0, idx + 1));
      pending = pending.slice(idx + 1);
    }
  };
  const hexByte = b => HEX[b >> 4] + HEX[b & 15];
  const HEX = '0123456789abcdef';
  return {
    write(input) {
      if (closed) throw new EncodingError('encoding/hex: dumper closed');
      const data = bytes(input);
      for (let i = 0; i < data.length; i++) {
        if (used === 0) {
          const off = n >>> 0;
          emit(hexByte(off >> 24) + hexByte((off >> 16) & 255) + hexByte((off >> 8) & 255) + hexByte(off & 255) + '  ');
        }
        let piece = hexByte(data[i]) + ' ';
        if (used === 7) piece += ' ';
        else if (used === 15) piece += ' |';
        emit(piece);
        right[used] = toChar(data[i]);
        used++;
        n++;
        if (used === 16) {
          emit(Buffer.from(right.subarray(0, 16)).toString('latin1') + '|\n');
          used = 0;
        }
      }
    },
    end() {
      if (closed) return;
      closed = true;
      if (used === 0) {
        if (pending) onLine(pending);
        return;
      }
      const nBytes = used;
      while (used < 16) {
        let piece = '   ';
        if (used === 7) piece = '    ';
        else if (used === 15) piece = '    |';
        emit(piece);
        used++;
      }
      emit(Buffer.from(right.subarray(0, nBytes)).toString('latin1') + '|\n');
      if (pending) onLine(pending);
    },
  };
}

function hexDumpAll(data) {
  const src = bytes(data);
  if (src.length === 0) return '';
  let out = '';
  const d = hexDumper(line => { out += line; });
  d.write(src);
  d.end();
  return out;
}

function ascii85Encode(src) { return native(() => binding.ascii85EncodeBytes(bytes(src))); }
function ascii85EncodeToString(src) { return Buffer.from(ascii85Encode(src)).toString('ascii'); }
function ascii85Decode(src, flush) {
  if (typeof flush !== 'boolean') throw new TypeError('encoding: ascii85Decode flush is required');
  return native(() => binding.ascii85DecodeBytes(textBytes(src), flush));
}
function ascii85MaxEncodedLen(n) { return ((uint(n) + 3) / 4 | 0) * 5; }

const MaxVarintLen16 = 3, MaxVarintLen32 = 5, MaxVarintLen64 = 10;
function asBigInt(value, signed) {
  if (typeof value !== 'bigint') throw new TypeError('encoding: expected bigint');
  if (!signed && value < 0n) throw new EncodingError('encoding/binary: uvarint value is negative');
  if (!signed && value > 0xffffffffffffffffn) throw new EncodingError('encoding/binary: uvarint exceeds uint64');
  if (signed && (value < -0x8000000000000000n || value > 0x7fffffffffffffffn)) {
    throw new EncodingError('encoding/binary: varint exceeds int64');
  }
  return value;
}
function binaryUvarint(value) { return native(() => binding.uvarintEncode(asBigInt(value, false))); }
function binaryAppendUvarint(dst, value) { return append(dst, binaryUvarint(value)); }
function binaryAppendVarint(dst, value) { return append(dst, native(() => binding.varintEncode(asBigInt(value, true)))); }
function binaryPutUvarint(dst, value, offset = 0) {
  const encoded = binaryUvarint(value);
  const start = uint(offset);
  if (start + encoded.length > bytes(dst).length) throw new BufferTooShortError('encoding/binary: insufficient data');
  bytes(dst).set(encoded, start);
  return encoded.length;
}
function binaryPutVarint(dst, value, offset = 0) {
  const encoded = native(() => binding.varintEncode(asBigInt(value, true)));
  const start = uint(offset);
  if (start + encoded.length > bytes(dst).length) throw new BufferTooShortError('encoding/binary: insufficient data');
  bytes(dst).set(encoded, start);
  return encoded.length;
}
function binaryReadUvarint(src, offset = 0) {
  return native(() => binding.uvarintDecode(bytes(src), uint(offset)));
}
function binaryReadVarint(src, offset = 0) {
  return native(() => binding.varintDecode(bytes(src), uint(offset)));
}

const sizes = { bool: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float32: 4, float64: 8 };
function binarySizeOf(schema) {
  if (!schema || typeof schema !== 'object') throw new EncodingError('encoding/binary: invalid schema');
  if (schema.kind === 'array') {
    if (!Number.isInteger(schema.len) || schema.len < 0) throw new EncodingError('encoding/binary: invalid array length');
    return binarySizeOf(schema.elem) * schema.len;
  }
  if (schema.kind === 'struct') {
    if (!Array.isArray(schema.fields)) throw new EncodingError('encoding/binary: invalid struct fields');
    return schema.fields.reduce((n, field) => n + binarySizeOf(field.type), 0);
  }
  const size = sizes[schema.kind];
  if (!size) throw new EncodingError(`encoding/binary: unsupported kind ${String(schema.kind)}`);
  return size;
}
function orderOf(order) {
  if (order === 'native') return endianness() === 'LE' ? 'le' : 'be';
  if (order === 'le' || order === 'be') return order;
  throw new EncodingError('encoding/binary: order must be le, be, or native');
}
function writeScalar(view, offset, kind, value, le) {
  switch (kind) {
    case 'bool': view.setUint8(offset, value ? 1 : 0); return;
    case 'int8': view.setInt8(offset, value); return;
    case 'uint8': view.setUint8(offset, value); return;
    case 'int16': view.setInt16(offset, value, le); return;
    case 'uint16': view.setUint16(offset, value, le); return;
    case 'int32': view.setInt32(offset, value, le); return;
    case 'uint32': view.setUint32(offset, value, le); return;
    case 'int64': view.setBigInt64(offset, value, le); return;
    case 'uint64': view.setBigUint64(offset, value, le); return;
    case 'float32': view.setFloat32(offset, value, le); return;
    case 'float64': view.setFloat64(offset, value, le); return;
    default: throw new EncodingError(`encoding/binary: unsupported kind ${kind}`);
  }
}
function readScalar(view, offset, kind, le) {
  switch (kind) {
    case 'bool': return view.getUint8(offset) !== 0;
    case 'int8': return view.getInt8(offset);
    case 'uint8': return view.getUint8(offset);
    case 'int16': return view.getInt16(offset, le);
    case 'uint16': return view.getUint16(offset, le);
    case 'int32': return view.getInt32(offset, le);
    case 'uint32': return view.getUint32(offset, le);
    case 'int64': return view.getBigInt64(offset, le);
    case 'uint64': return view.getBigUint64(offset, le);
    case 'float32': return view.getFloat32(offset, le);
    case 'float64': return view.getFloat64(offset, le);
    default: throw new EncodingError(`encoding/binary: unsupported kind ${kind}`);
  }
}
function encodeValue(view, offset, schema, value, le) {
  if (schema.kind === 'array') {
    if (!Array.isArray(value) || value.length !== schema.len) {
      throw new EncodingError('encoding/binary: array length mismatch');
    }
    let pos = offset;
    for (const item of value) pos = encodeValue(view, pos, schema.elem, item, le);
    return pos;
  }
  if (schema.kind === 'struct') {
    if (value === null || typeof value !== 'object') throw new EncodingError('encoding/binary: expected struct object');
    let pos = offset;
    for (const field of schema.fields) pos = encodeValue(view, pos, field.type, value[field.name], le);
    return pos;
  }
  writeScalar(view, offset, schema.kind, value, le);
  return offset + sizes[schema.kind];
}
function decodeValue(view, offset, end, schema, le) {
  if (offset + (schema.kind === 'array' || schema.kind === 'struct' ? 0 : sizes[schema.kind] || 0) > end) {
    throw new BufferTooShortError('encoding/binary: insufficient data');
  }
  if (schema.kind === 'array') {
    const items = [];
    let pos = offset;
    for (let i = 0; i < schema.len; i++) {
      const next = decodeValue(view, pos, end, schema.elem, le);
      items.push(next.value);
      pos = next.n;
    }
    return { value: items, n: pos };
  }
  if (schema.kind === 'struct') {
    const obj = {};
    let pos = offset;
    for (const field of schema.fields) {
      const next = decodeValue(view, pos, end, field.type, le);
      obj[field.name] = next.value;
      pos = next.n;
    }
    return { value: obj, n: pos };
  }
  const size = sizes[schema.kind];
  if (offset + size > end) throw new BufferTooShortError('encoding/binary: insufficient data');
  return { value: readScalar(view, offset, schema.kind, le), n: offset + size };
}
function binaryEncode(schema, value, order) {
  const size = binarySizeOf(schema);
  const buf = new Uint8Array(size);
  encodeValue(new DataView(buf.buffer), 0, schema, value, orderOf(order) === 'le');
  return buf;
}
function binaryDecode(schema, src, order) {
  const bytesIn = bytes(src);
  const decoded = decodeValue(new DataView(bytesIn.buffer, bytesIn.byteOffset, bytesIn.byteLength), 0, bytesIn.byteLength, schema, orderOf(order) === 'le');
  return { value: decoded.value, n: decoded.n };
}

function tryBinaryMarshaler(value) {
  if (value && typeof value.toBinary === 'function') {
    const out = value.toBinary();
    if (!ArrayBuffer.isView(out) || Object.prototype.toString.call(out) !== '[object Uint8Array]') {
      throw new TypeError('encoding: toBinary must return Uint8Array');
    }
    return out;
  }
}
function tryTextMarshaler(value) {
  if (value && typeof value.toText === 'function') {
    const out = value.toText();
    if (typeof out !== 'string') throw new TypeError('encoding: toText must return string');
    return out;
  }
}

function dumpGob(type, value) {
  if (type == null || typeof type !== 'object' || typeof type.kind !== 'string') {
    throw new GobTypeError('encoding/gob: invalid GobType');
  }
  const k = type.kind;
  if (value == null) {
    if (k === 'interface' || k === 'slice' || k === 'map' || k === 'bytes') return null;
    if (k === 'struct') {
      const o = {};
      for (const f of type.fields || []) o[f.name] = dumpGob(f.type, undefined);
      return o;
    }
  }
  switch (k) {
    case 'bool': return !!value;
    case 'int': case 'int8': case 'int16': case 'int32':
      if (typeof value === 'bigint') return value.toString();
      if (value == null) return 0;
      return Number(value);
    case 'int64':
      if (value == null) return '0';
      return typeof value === 'bigint' ? value.toString() : String(BigInt(value));
    case 'uint': case 'uint8': case 'uint16': case 'uint32':
      if (typeof value === 'bigint') return value.toString();
      if (value == null) return 0;
      return Number(value);
    case 'uint64':
      if (value == null) return '0';
      return typeof value === 'bigint' ? value.toString() : String(BigInt(value));
    case 'float32': case 'float64': return value == null ? 0 : Number(value);
    case 'complex64': case 'complex128':
      if (value == null) return { re: 0, im: 0 };
      if (Array.isArray(value)) return { re: Number(value[0]), im: Number(value[1]) };
      return { re: Number(value.re ?? value.real ?? 0), im: Number(value.im ?? value.imag ?? 0) };
    case 'string': return value == null ? '' : String(value);
    case 'bytes':
      if (value == null) return { $b: '' };
      return { $b: Buffer.from(value).toString('hex') };
    case 'array':
      if (!Array.isArray(value) || value.length !== type.len) throw new GobTypeError('encoding/gob: array length mismatch');
      return value.map((item) => dumpGob(type.elem, item));
    case 'slice':
      if (value == null) return null;
      if (type.elem && type.elem.kind === 'uint8' && !Array.isArray(value)) return { $b: Buffer.from(value).toString('hex') };
      if (!Array.isArray(value)) throw new GobTypeError('encoding/gob: expected slice');
      return value.map((item) => dumpGob(type.elem, item));
    case 'map': {
      if (value == null) return null;
      const pairs = [];
      const entries = value instanceof Map ? value.entries() : Object.entries(value);
      for (const [mk, mv] of entries) pairs.push([dumpGob(type.key, mk), dumpGob(type.elem, mv)]);
      return { $m: pairs };
    }
    case 'struct': {
      const o = {};
      if (value == null || typeof value !== 'object') throw new GobTypeError('encoding/gob: expected struct', type.name);
      for (const f of type.fields || []) o[f.name] = dumpGob(f.type, value[f.name]);
      return o;
    }
    case 'interface':
      if (value == null) return null;
      if (typeof value === 'object' && value.$name) return { $i: value.$name, $v: dumpGob(value.$type || type, value.$value) };
      throw new GobTypeError('encoding/gob: interface value needs { $name, $type, $value }');
    case 'gobEncoder': {
      if (value && typeof value.gobEncode === 'function') return { $g: Buffer.from(value.gobEncode()).toString('hex') };
      const bin = tryBinaryMarshaler(value);
      if (bin) return { $g: Buffer.from(bin).toString('hex') };
      throw new GobTypeError('encoding/gob: gobEncoder requires gobEncode()', type.name);
    }
    default: throw new GobTypeError(`encoding/gob: unsupported kind ${k}`, k);
  }
}

function loadGob(type, json) {
  if (json == null) {
    if (type.kind === 'slice' || type.kind === 'map' || type.kind === 'interface') return null;
  }
  switch (type.kind) {
    case 'bool': return !!json;
    case 'int': case 'int8': case 'int16': case 'int32': return typeof json === 'string' ? Number(json) : json;
    case 'int64': return BigInt(json ?? 0);
    case 'uint': case 'uint8': case 'uint16': case 'uint32': return typeof json === 'string' ? Number(json) : json;
    case 'uint64': return BigInt(json ?? 0);
    case 'float32': case 'float64': return Number(json ?? 0);
    case 'complex64': case 'complex128': return { real: Number(json?.re ?? 0), imag: Number(json?.im ?? 0) };
    case 'string': return json == null ? '' : String(json);
    case 'bytes':
    case 'gobEncoder': {
      const hex = json && (json.$b || json.$g) || '';
      return Uint8Array.from(Buffer.from(hex, 'hex'));
    }
    case 'array':
      return (json || []).map((item) => loadGob(type.elem, item));
    case 'slice':
      if (json == null) return null;
      if (json.$b != null) return Uint8Array.from(Buffer.from(json.$b, 'hex'));
      return json.map((item) => loadGob(type.elem, item));
    case 'map': {
      if (json == null) return null;
      const m = new Map();
      for (const [mk, mv] of json.$m || []) m.set(loadGob(type.key, mk), loadGob(type.elem, mv));
      return m;
    }
    case 'struct': {
      const o = {};
      for (const f of type.fields || []) o[f.name] = loadGob(f.type, json ? json[f.name] : undefined);
      return o;
    }
    case 'interface':
      if (json == null) return null;
      return { $name: json.$i, $value: json.$v };
    default: return json;
  }
}

class GobEncoder {
  constructor(opts = {}) {
    if (opts !== undefined && (opts === null || typeof opts !== 'object')) {
      throw new TypeError('encoding/gob: options must be an object');
    }
    this._native = new binding.NativeGobEncoder();
    this._chunks = [];
    this.onChunk = opts.onChunk;
  }
  encode(value, type) {
    const bytes = native(() => this._native.encode(JSON.stringify(type), JSON.stringify(dumpGob(type, value))));
    this._chunks.push(bytes);
    if (typeof this.onChunk === 'function') this.onChunk(bytes);
  }
  finish() {
    const total = this._chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this._chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  reset() { this._native.reset(); this._chunks = []; }
}

class GobDecoder {
  constructor(opts = {}) {
    if (opts !== undefined && (opts === null || typeof opts !== 'object')) {
      throw new TypeError('encoding/gob: options must be an object');
    }
    const max = opts.maxTypeSize == null ? 0n : BigInt(opts.maxTypeSize);
    this._native = new binding.NativeGobDecoder(max);
  }
  write(chunk) { native(() => this._native.write(bytes(chunk))); }
  decode(type) {
    const json = native(() => this._native.decode(JSON.stringify(type)));
    return loadGob(type, JSON.parse(json));
  }
  readType() {
    const name = native(() => this._native.readType());
    if (name == null) return null;
    return { kind: 'struct', name, fields: [] };
  }
  reset() { this._native.reset(); }
}

function gobRegisterName(name, type) {
  if (typeof name !== 'string' || !name) throw new GobTypeError('encoding/gob: empty register name');
  native(() => binding.gobRegisterNameNative(name, JSON.stringify(type)));
}
function gobEncode(value, type) {
  const enc = new GobEncoder();
  enc.encode(value, type);
  return enc.finish();
}
function gobDecode(data, type) {
  const dec = new GobDecoder();
  dec.write(bytes(data));
  return dec.decode(type);
}

module.exports = {
  EncodingError, CorruptInputError, InvalidByteError, HexLengthError, BufferTooShortError, VarintOverflowError, GobTypeError,
  Base64Encoding, Base32Encoding,
  hexEncode, hexDecode, hexAppendEncode, hexAppendDecode, hexEncodedLen, hexDecodedLen,
  hexDump: hexDumpAll, hexDumper,
  ascii85Encode, ascii85EncodeToString, ascii85Decode, ascii85MaxEncodedLen,
  binaryReadUvarint, binaryReadVarint, binaryPutUvarint, binaryPutVarint,
  binaryAppendUvarint, binaryAppendVarint, binaryUvarint,
  binarySizeOf, binaryEncode, binaryDecode,
  MaxVarintLen16, MaxVarintLen32, MaxVarintLen64,
  tryBinaryMarshaler, tryTextMarshaler,
  GobEncoder, GobDecoder, gobRegisterName, gobEncode, gobDecode,
};
