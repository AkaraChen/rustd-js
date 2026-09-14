'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-mathx';
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

function native(fn) {
  try { return fn(); } catch (cause) {
    const message = cause.message ?? String(cause);
    if (message.startsWith('RangeError: ')) {
      throw new RangeError(message.slice('RangeError: '.length), { cause });
    }
    throw cause;
  }
}

function uInt(name, x, bits) {
  const max = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > max) {
    throw new RangeError(`math/bits: ${name} out of range`);
  }
  return bits === 32 ? x >>> 0 : x;
}
function u8(name, x) { return uInt(name, x, 8); }
function u16(name, x) { return uInt(name, x, 16); }
function u32(name, x) { return uInt(name, x, 32); }
const U64_MAX = 0xffffffffffffffffn;
function u64(name, x) {
  if (typeof x !== 'bigint' || x < 0n || x > U64_MAX) {
    throw new RangeError(`math/bits: ${name} out of range`);
  }
  return x;
}
function rotK(k) {
  if (typeof k !== 'number' || !Number.isInteger(k)) {
    throw new RangeError('math/bits: rotate amount must be an integer');
  }
  return k;
}
function bit01(name, x, asBig) {
  if (asBig) {
    if (x !== 0n && x !== 1n) throw new RangeError(`math/bits: ${name} must be 0 or 1`);
    return x;
  }
  if (x !== 0 && x !== 1) throw new RangeError(`math/bits: ${name} must be 0 or 1`);
  return x;
}

function leadingZeros8(x) { return binding.leadingZeros8(u8('x', x)); }
function leadingZeros16(x) { return binding.leadingZeros16(u16('x', x)); }
function leadingZeros32(x) { return binding.leadingZeros32(u32('x', x)); }
function leadingZeros64(x) { return native(() => binding.leadingZeros64(u64('x', x))); }
function trailingZeros8(x) { return binding.trailingZeros8(u8('x', x)); }
function trailingZeros16(x) { return binding.trailingZeros16(u16('x', x)); }
function trailingZeros32(x) { return binding.trailingZeros32(u32('x', x)); }
function trailingZeros64(x) { return native(() => binding.trailingZeros64(u64('x', x))); }
function onesCount8(x) { return binding.onesCount8(u8('x', x)); }
function onesCount16(x) { return binding.onesCount16(u16('x', x)); }
function onesCount32(x) { return binding.onesCount32(u32('x', x)); }
function onesCount64(x) { return native(() => binding.onesCount64(u64('x', x))); }
function len8(x) { return binding.len8(u8('x', x)); }
function len16(x) { return binding.len16(u16('x', x)); }
function len32(x) { return binding.len32(u32('x', x)); }
function len64(x) { return native(() => binding.len64(u64('x', x))); }
function rotateLeft8(x, k) { return binding.rotateLeft8(u8('x', x), rotK(k)); }
function rotateLeft16(x, k) { return binding.rotateLeft16(u16('x', x), rotK(k)); }
function rotateLeft32(x, k) { return binding.rotateLeft32(u32('x', x), rotK(k)) >>> 0; }
function rotateLeft64(x, k) { return native(() => binding.rotateLeft64(u64('x', x), rotK(k))); }
function reverse8(x) { return binding.reverse8(u8('x', x)); }
function reverse16(x) { return binding.reverse16(u16('x', x)); }
function reverse32(x) { return binding.reverse32(u32('x', x)) >>> 0; }
function reverse64(x) { return native(() => binding.reverse64(u64('x', x))); }
function reverseBytes16(x) { return binding.reverseBytes16(u16('x', x)); }
function reverseBytes32(x) { return binding.reverseBytes32(u32('x', x)) >>> 0; }
function reverseBytes64(x) { return native(() => binding.reverseBytes64(u64('x', x))); }

function add32(x, y, carry) {
  const result = native(() => binding.add32(u32('x', x), u32('y', y), bit01('carry', u32('carry', carry), false)));
  return { sum: result.sum >>> 0, carryOut: result.carryOut >>> 0 };
}
function add64(x, y, carry) {
  return native(() => binding.add64(u64('x', x), u64('y', y), bit01('carry', u64('carry', carry), true)));
}
function sub32(x, y, borrow) {
  const result = native(() => binding.sub32(u32('x', x), u32('y', y), bit01('borrow', u32('borrow', borrow), false)));
  return { diff: result.diff >>> 0, borrowOut: result.borrowOut >>> 0 };
}
function sub64(x, y, borrow) {
  return native(() => binding.sub64(u64('x', x), u64('y', y), bit01('borrow', u64('borrow', borrow), true)));
}
function mul32(x, y) {
  const result = binding.mul32(u32('x', x), u32('y', y));
  return { hi: result.hi >>> 0, lo: result.lo >>> 0 };
}
function mul64(x, y) {
  return native(() => binding.mul64(u64('x', x), u64('y', y)));
}
function div32(hi, lo, y) {
  const result = native(() => binding.div32(u32('hi', hi), u32('lo', lo), u32('y', y)));
  return { quo: result.quo >>> 0, rem: result.rem >>> 0 };
}
function div64(hi, lo, y) {
  return native(() => binding.div64(u64('hi', hi), u64('lo', lo), u64('y', y)));
}
function rem32(hi, lo, y) { return native(() => binding.rem32(u32('hi', hi), u32('lo', lo), u32('y', y))) >>> 0; }
function rem64(hi, lo, y) { return native(() => binding.rem64(u64('hi', hi), u64('lo', lo), u64('y', y))); }

function asComplex(x, label = 'x') {
  if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'number' || typeof x[1] !== 'number') {
    throw new TypeError(`math/cmplx: ${label} must be [re, im]`);
  }
  return x;
}
function asNumber(name, x) {
  if (typeof x !== 'number') throw new TypeError(`math/cmplx: ${name} must be a number`);
  return x;
}
function complexOut(pair) {
  return Object.freeze([pair[0], pair[1]]);
}

function cAbs(x) { const [re, im] = asComplex(x); return binding.cAbs(re, im); }
function cArg(x) { const [re, im] = asComplex(x); return binding.cArg(re, im); }
function cNorm(x) { const [re, im] = asComplex(x); return binding.cNorm(re, im); }
function cConj(x) { const [re, im] = asComplex(x); return complexOut(binding.cConj(re, im)); }
function cRect(r, phi) { return complexOut(binding.cRect(asNumber('r', r), asNumber('φ', phi))); }
function cPolar(x) {
  const [re, im] = asComplex(x);
  const polar = binding.cPolar(re, im);
  return { r: polar.r, φ: polar.phi };
}
function cExp(x) { const [re, im] = asComplex(x); return complexOut(binding.cExp(re, im)); }
function cLog(x) { const [re, im] = asComplex(x); return complexOut(binding.cLog(re, im)); }
function cPow(x, y) {
  const [xr, xi] = asComplex(x, 'x');
  const [yr, yi] = asComplex(y, 'y');
  return complexOut(binding.cPow(xr, xi, yr, yi));
}
function cSqrt(x) { const [re, im] = asComplex(x); return complexOut(binding.cSqrt(re, im)); }
function cSin(x) { const [re, im] = asComplex(x); return complexOut(binding.cSin(re, im)); }
function cCos(x) { const [re, im] = asComplex(x); return complexOut(binding.cCos(re, im)); }
function cTan(x) { const [re, im] = asComplex(x); return complexOut(binding.cTan(re, im)); }
function cSinh(x) { const [re, im] = asComplex(x); return complexOut(binding.cSinh(re, im)); }
function cCosh(x) { const [re, im] = asComplex(x); return complexOut(binding.cCosh(re, im)); }
function cTanh(x) { const [re, im] = asComplex(x); return complexOut(binding.cTanh(re, im)); }
function cAsin(x) { const [re, im] = asComplex(x); return complexOut(binding.cAsin(re, im)); }
function cAcos(x) { const [re, im] = asComplex(x); return complexOut(binding.cAcos(re, im)); }
function cAtan(x) { const [re, im] = asComplex(x); return complexOut(binding.cAtan(re, im)); }
function cAsinh(x) { const [re, im] = asComplex(x); return complexOut(binding.cAsinh(re, im)); }
function cAcosh(x) { const [re, im] = asComplex(x); return complexOut(binding.cAcosh(re, im)); }
function cAtanh(x) { const [re, im] = asComplex(x); return complexOut(binding.cAtanh(re, im)); }
function cCot(x) { const [re, im] = asComplex(x); return complexOut(binding.cCot(re, im)); }
function cInf() { return complexOut(binding.cInf()); }
function cNaN() { return complexOut(binding.cNaN()); }
function cIsInf(x, sign) {
  const [re, im] = asComplex(x);
  if (sign === undefined) return binding.cIsInf(re, im);
  if (typeof sign !== 'number' || !Number.isInteger(sign)) {
    throw new RangeError('math/cmplx: sign must be an integer');
  }
  return binding.cIsInf(re, im, sign);
}
function cIsNaN(x) { const [re, im] = asComplex(x); return binding.cIsNaN(re, im); }

module.exports = {
  leadingZeros8, leadingZeros16, leadingZeros32, leadingZeros64,
  trailingZeros8, trailingZeros16, trailingZeros32, trailingZeros64,
  onesCount8, onesCount16, onesCount32, onesCount64,
  len8, len16, len32, len64,
  rotateLeft8, rotateLeft16, rotateLeft32, rotateLeft64,
  reverse8, reverse16, reverse32, reverse64,
  reverseBytes16, reverseBytes32, reverseBytes64,
  add32, add64, sub32, sub64, mul32, mul64, div32, div64, rem32, rem64,
  cAbs, cArg, cNorm, cConj, cRect, cPolar, cExp, cLog, cPow, cSqrt,
  cSin, cCos, cTan, cSinh, cCosh, cTanh, cAsin, cAcos, cAtan, cAsinh, cAcosh, cAtanh, cCot,
  cInf, cNaN, cIsInf, cIsNaN,
};
