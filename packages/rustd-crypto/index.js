'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-crypto';
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
// Do not hide a broken local binary behind an optional-package fallback.
const binding = existsSync(local) ? require(local) : require(`${name}-${platform}`);

class CryptoError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
  static code = 'ERR_CRYPTO';
}
class UnsupportedAlgorithmError extends CryptoError { static code = 'ERR_CRYPTO_UNSUPPORTED_ALGORITHM'; }
class InsecureAlgorithmError extends CryptoError { static code = 'ERR_CRYPTO_INSECURE_ALGORITHM'; }
class HashFinalizedError extends CryptoError { static code = 'ERR_CRYPTO_HASH_FINALIZED'; }
const errors = { UnsupportedAlgorithmError, InsecureAlgorithmError, HashFinalizedError };
function native(fn) {
  try { return fn(); } catch (cause) {
    const colon = cause.message?.indexOf(':');
    const ErrorClass = errors[cause.message?.slice(0, colon)] ?? CryptoError;
    throw new ErrorClass(cause.message?.slice(colon + 2) ?? String(cause), { cause });
  }
}
const algorithms = Object.freeze({
  md5: [16, 64], sha1: [20, 64], sha224: [28, 64], sha256: [32, 64],
  sha384: [48, 128], sha512: [64, 128], 'sha512-224': [28, 128], 'sha512-256': [32, 128],
});
const algoNames = Object.freeze(Object.keys(algorithms));
function checkAlgo(algo) {
  if (typeof algo !== 'string' || !Object.hasOwn(algorithms, algo)) {
    throw new UnsupportedAlgorithmError(`crypto: unsupported hash algorithm ${String(algo)}`);
  }
  return algorithms[algo];
}
function bytes(value) {
  // Accept Buffer and Uint8Array across realms, but reject other typed arrays.
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('crypto: expected Uint8Array');
  }
  return value;
}
const encoder = new TextEncoder();
function input(value) { return typeof value === 'string' ? encoder.encode(value) : bytes(value); }
function allowLegacy(options) {
  if (options === undefined) return false;
  if (options === null || typeof options !== 'object' ||
      (options.allowLegacy !== undefined && typeof options.allowLegacy !== 'boolean')) {
    throw new TypeError('crypto: allowLegacy must be a boolean');
  }
  return options.allowLegacy === true;
}
function append(prefix, digest) {
  const result = new Uint8Array(prefix.length + digest.length);
  result.set(prefix); result.set(digest, prefix.length);
  return result;
}
function hashObject(handle, algo) {
  const [size, blockSize] = algorithms[algo];
  return Object.freeze({
    size, blockSize,
    update(data) { const value = input(data); native(() => handle.update(value)); return this; },
    digest(enc) {
      if (enc !== undefined && !['hex', 'base64', 'base64url'].includes(enc)) {
        throw new TypeError('crypto: unsupported digest encoding');
      }
      const result = native(() => handle.digest());
      return enc === undefined ? result : Buffer.from(result).toString(enc);
    },
    sum(prefix = new Uint8Array()) { return append(bytes(prefix), native(() => handle.sum())); },
    squeeze() { throw new UnsupportedAlgorithmError('crypto: squeeze requires an XOF algorithm'); },
    clone() { return hashObject(native(() => handle.cloneState()), algo); },
    reset() { native(() => handle.reset()); },
  });
}
function createHash(algo, options) {
  checkAlgo(algo);
  const legacy = allowLegacy(options);
  return hashObject(native(() => new binding.NativeDigest(algo, undefined, legacy)), algo);
}
function hash(algo, data, options) { return createHash(algo, options).update(data).digest(); }
function createHmac(algo, key, options) {
  const [size] = checkAlgo(algo);
  const keyBytes = bytes(key);
  const legacy = allowLegacy(options);
  const handle = native(() => new binding.NativeDigest(algo, keyBytes, legacy));
  return Object.freeze({
    size,
    update(data) { const value = input(data); native(() => handle.update(value)); return this; },
    digest() { return native(() => handle.digest()); },
    sum(prefix = new Uint8Array()) { return append(bytes(prefix), native(() => handle.sum())); },
    reset() { native(() => handle.reset()); },
  });
}
function hmacEqual(a, b) { return binding.hmacEqual(bytes(a), bytes(b)); }
function availableAlgos() { return algoNames; }
function fips140Enabled() { return false; }
module.exports = { CryptoError, ...errors, createHash, hash, createHmac, hmacEqual, availableAlgos, fips140Enabled };
