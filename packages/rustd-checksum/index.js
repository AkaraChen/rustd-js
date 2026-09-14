'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-checksum';
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

class ChecksumError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
  static code = 'ERR_CHECKSUM';
}
class UninitializedSeedError extends ChecksumError { static code = 'ERR_CHECKSUM_UNINITIALIZED_SEED'; }
const errors = { ChecksumError, UninitializedSeedError };
function native(fn) {
  try { return fn(); } catch (cause) {
    const colon = cause.message?.indexOf(':');
    const ErrorClass = errors[cause.message?.slice(0, colon)] ?? ChecksumError;
    throw new ErrorClass(cause.message?.slice(colon + 2) ?? String(cause), { cause });
  }
}
function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('checksum: expected Uint8Array');
  }
  return value;
}
function u32(value, label = 'value') {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ChecksumError(`checksum: ${label} must be an unsigned 32-bit integer`);
  }
  return value >>> 0;
}
function optU32(value, label = 'seed') {
  return value === undefined ? undefined : u32(value, label);
}
function u64(value, label = 'value') {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn) {
    throw new ChecksumError(`checksum: ${label} must be an unsigned 64-bit integer`);
  }
  return value;
}
function optU64(value, label = 'seed') {
  return value === undefined ? undefined : u64(value, label);
}
function u128(value, label = 'seed') {
  if (typeof value !== 'bigint' || value < 0n || value > (1n << 128n) - 1n) {
    throw new ChecksumError(`checksum: ${label} must be an unsigned 128-bit integer`);
  }
  return value;
}
const CRC32_POLY = Object.freeze({ ieee: 0xedb88320, castagnoli: 0x82f63b78, koopman: 0xeb31d82e });
const CRC64_POLY = Object.freeze({ iso: 0xd800000000000000n, ecma: 0xc96c5795d7870f42n });
function crc32Poly(poly) {
  if (typeof poly === 'string' && Object.hasOwn(CRC32_POLY, poly)) return CRC32_POLY[poly];
  if (typeof poly === 'number') return u32(poly, 'poly');
  throw new ChecksumError('checksum: crc32 poly must be ieee, castagnoli, koopman, or an unsigned 32-bit integer');
}
function crc64Poly(poly) {
  if (typeof poly === 'string' && Object.hasOwn(CRC64_POLY, poly)) return CRC64_POLY[poly];
  if (typeof poly === 'bigint') return u64(poly, 'poly');
  throw new ChecksumError('checksum: crc64 poly must be iso, ecma, or an unsigned 64-bit integer');
}
function digestInto(handle, dst, offset) {
  const out = native(() => handle.digest());
  const start = offset === undefined ? 0 : offset;
  if (!ArrayBuffer.isView(dst) || Object.prototype.toString.call(dst) !== '[object Uint8Array]') {
    throw new TypeError('checksum: expected Uint8Array');
  }
  if (!Number.isInteger(start) || start < 0 || start + out.length > dst.length) {
    throw new ChecksumError('checksum: digestInto destination is too small');
  }
  dst.set(out, start);
  return out.length;
}
function attach(ctor) {
  ctor.prototype.update = function update(data) {
    native(() => this._n.update(bytes(data)));
    return this;
  };
  ctor.prototype.digest = function digest() { return native(() => this._n.digest()); };
  ctor.prototype.digestInto = function digestIntoFn(dst, offset) { return digestInto(this._n, dst, offset); };
  ctor.prototype.reset = function reset() { native(() => this._n.reset()); };
  ctor.prototype.clone = function clone() {
    const copy = Object.create(ctor.prototype);
    copy._n = native(() => this._n.cloneHash());
    return copy;
  };
  ctor.prototype.size = function size() { return this._n.size(); };
  ctor.prototype.blockSize = function blockSize() { return this._n.blockSize(); };
}
function attach32(ctor) {
  attach(ctor);
  ctor.prototype.digest32 = function digest32() { return native(() => this._n.digest32()) >>> 0; };
}
function attach64(ctor) {
  attach(ctor);
  ctor.prototype.digest64 = function digest64() { return native(() => this._n.digest64()); };
}
function attach128(ctor) {
  attach(ctor);
  ctor.prototype.digest128 = function digest128() { return native(() => this._n.digest128()); };
}

class Crc32Table {
  constructor(poly) {
    this._n = native(() => new binding.Crc32Table(crc32Poly(poly)));
  }
  checksum(data, seed) {
    return native(() => this._n.checksum(bytes(data), optU32(seed))) >>> 0;
  }
  update(crc, data) {
    return native(() => this._n.update(u32(crc, 'crc'), bytes(data))) >>> 0;
  }
}
class Crc64Table {
  constructor(poly) {
    this._n = native(() => new binding.Crc64Table(crc64Poly(poly)));
  }
  checksum(data, seed) {
    return native(() => this._n.checksum(bytes(data), optU64(seed)));
  }
  update(crc, data) {
    return native(() => this._n.update(u64(crc, 'crc'), bytes(data)));
  }
}

class Adler32 {
  constructor(seed) {
    this._n = native(() => binding.NativeHash.adler32(optU32(seed)));
  }
}
class Crc32 {
  constructor(table) {
    const tab = table === undefined ? new Crc32Table('ieee') : table;
    if (!(tab instanceof Crc32Table)) throw new TypeError('checksum: expected Crc32Table');
    this._n = native(() => binding.NativeHash.crc32(tab._n));
  }
}
class Crc64 {
  constructor(table) {
    if (!(table instanceof Crc64Table)) throw new TypeError('checksum: expected Crc64Table');
    this._n = native(() => binding.NativeHash.crc64(table._n));
  }
}
class Fnv32 { constructor() { this._n = binding.NativeHash.fnv32(false); } }
class Fnv32a { constructor() { this._n = binding.NativeHash.fnv32(true); } }
class Fnv64 { constructor() { this._n = binding.NativeHash.fnv64(false); } }
class Fnv64a { constructor() { this._n = binding.NativeHash.fnv64(true); } }
class Fnv128 { constructor() { this._n = binding.NativeHash.fnv128(false); } }
class Fnv128a { constructor() { this._n = binding.NativeHash.fnv128(true); } }
class MapHash {
  constructor(seed) {
    this._n = native(() => binding.NativeHash.maphash(seed === undefined ? maphashSeed() : u128(seed)));
  }
  seed() { return native(() => this._n.seed()); }
  setSeed(seed) { native(() => this._n.setSeed(u128(seed))); }
  updateString(s) {
    if (typeof s !== 'string') throw new TypeError('checksum: expected string');
    native(() => this._n.update(encoder.encode(s)));
    return this;
  }
  updateComparable(value) {
    native(() => this._n.update(comparableBytes(value)));
    return this;
  }
}
attach32(Adler32); attach32(Crc32); attach32(Fnv32); attach32(Fnv32a);
attach64(Crc64); attach64(Fnv64); attach64(Fnv64a); attach64(MapHash);
attach128(Fnv128); attach128(Fnv128a);

const encoder = new TextEncoder();
function comparableBytes(value) {
  if (typeof value === 'boolean') return new Uint8Array([0, value ? 1 : 0]);
  if (typeof value === 'number') {
    const out = new Uint8Array(9);
    out[0] = 1;
    new DataView(out.buffer).setFloat64(1, value, true);
    return out;
  }
  if (typeof value === 'bigint') {
    const negative = value < 0n;
    let n = negative ? -value : value;
    const payload = [];
    while (n > 0n) {
      payload.push(Number(n & 0xffn));
      n >>= 8n;
    }
    const out = new Uint8Array(2 + payload.length);
    out[0] = 2;
    out[1] = negative ? 1 : 0;
    out.set(payload, 2);
    return out;
  }
  if (typeof value === 'string') {
    const utf8 = encoder.encode(value);
    const out = new Uint8Array(1 + utf8.length);
    out[0] = 3;
    out.set(utf8, 1);
    return out;
  }
  throw new TypeError('checksum: comparable value must be boolean, number, bigint, or string');
}
function maphashSeed() {
  const bytes16 = new Uint8Array(16);
  let seed = 0n;
  do {
    crypto.getRandomValues(bytes16);
    seed = 0n;
    for (const b of bytes16) seed = (seed << 8n) | BigInt(b);
  } while (seed === 0n);
  return seed;
}

function adler32(data, seed) {
  return native(() => binding.adler32(bytes(data), optU32(seed))) >>> 0;
}
function crc32ieee(data, seed) {
  return native(() => binding.crc32Ieee(bytes(data), optU32(seed))) >>> 0;
}
function crc32(data, opts) {
  const input = bytes(data);
  if (opts === undefined) return crc32ieee(input);
  if (opts === null || typeof opts !== 'object') throw new TypeError('checksum: crc32 options must be an object');
  const seed = optU32(opts.seed);
  if (opts.table !== undefined) {
    if (!(opts.table instanceof Crc32Table)) throw new TypeError('checksum: expected Crc32Table');
    return opts.table.checksum(input, seed);
  }
  const poly = opts.poly === undefined ? CRC32_POLY.ieee : crc32Poly(opts.poly);
  return native(() => binding.crc32Poly(input, poly, seed)) >>> 0;
}
function crc64(data, opts) {
  if (opts === null || typeof opts !== 'object') throw new TypeError('checksum: crc64 options must be an object');
  const input = bytes(data);
  const seed = optU64(opts.seed);
  if (opts.table !== undefined) {
    if (!(opts.table instanceof Crc64Table)) throw new TypeError('checksum: expected Crc64Table');
    return opts.table.checksum(input, seed);
  }
  if (opts.poly === undefined) throw new ChecksumError('checksum: crc64 requires poly or table');
  return native(() => binding.crc64Poly(input, crc64Poly(opts.poly), seed));
}
function fnv32(data) { return native(() => binding.fnv32(bytes(data), false)) >>> 0; }
function fnv32a(data) { return native(() => binding.fnv32(bytes(data), true)) >>> 0; }
function fnv64(data) { return native(() => binding.fnv64(bytes(data), false)); }
function fnv64a(data) { return native(() => binding.fnv64(bytes(data), true)); }
function fnv128(data) { return native(() => binding.fnv128(bytes(data), false)); }
function fnv128a(data) { return native(() => binding.fnv128(bytes(data), true)); }
function maphashBytes(seed, data) {
  return native(() => binding.maphashBytes(u128(seed), bytes(data)));
}
function maphashString(seed, s) {
  if (typeof s !== 'string') throw new TypeError('checksum: expected string');
  return maphashBytes(seed, encoder.encode(s));
}

module.exports = {
  ChecksumError, UninitializedSeedError,
  Crc32Table, Crc64Table,
  Adler32, Crc32, Crc64, Fnv32, Fnv32a, Fnv64, Fnv64a, Fnv128, Fnv128a, MapHash,
  adler32, crc32, crc32ieee, crc64,
  fnv32, fnv32a, fnv64, fnv64a, fnv128, fnv128a,
  maphashSeed, maphashBytes, maphashString,
};
