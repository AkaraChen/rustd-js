import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import * as mathx from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const buf = new ArrayBuffer(8);
const f64 = new Float64Array(buf);
const u64 = new BigUint64Array(buf);
function bitsOf(n) {
  f64[0] = n;
  return u64[0].toString(16).padStart(16, '0');
}
function fromBits(hex) {
  u64[0] = BigInt('0x' + hex);
  return f64[0];
}
function C(hex) {
  return Object.freeze([fromBits(hex.re), fromBits(hex.im)]);
}

let cached;
function goOracle() {
  if (cached) return cached;
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const args = command === 'go' ? ['run', 'cmplx_oracle.go'] : ['exec', '--', 'go', 'run', 'cmplx_oracle.go'];
  const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`oracle failed: ${result.stderr}`);
  cached = JSON.parse(result.stdout);
  return cached;
}

function eqBits(actual, expectedHex, label) {
  const got = bitsOf(actual);
  if (got === expectedHex) return;
  const expected = fromBits(expectedHex);
  // V8 canonicalizes NaN payloads to 0x7ff8000000000000; Go uses 0x7ff8000000000001.
  if (Number.isNaN(actual) && Number.isNaN(expected)) return;
  const diffs = (globalThis.__cmplxDiffs ??= []);
  const ulp = finiteUlp(actual, expected);
  diffs.push({
    label,
    expected: expectedHex,
    actual: got,
    value: actual,
    kind: classify(actual, expected, ulp),
    ulp,
  });
}
function finiteUlp(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  f64[0] = a; const ia = u64[0];
  f64[0] = b; const ib = u64[0];
  const d = ia > ib ? ia - ib : ib - ia;
  return d > 0xffffffffffffn ? Number.POSITIVE_INFINITY : Number(d);
}
function classify(actual, expected, ulp) {
  if (Object.is(actual, expected)) return 'equal';
  if (Number.isNaN(actual) !== Number.isNaN(expected)) return 'nan-vs-number';
  if (actual === Infinity || actual === -Infinity || expected === Infinity || expected === -Infinity) return 'inf-mismatch';
  if (Object.is(actual, 0) || Object.is(actual, -0) || Object.is(expected, 0) || Object.is(expected, -0)) return 'signed-zero';
  if (ulp != null) return 'libm-ulp';
  return 'other';
}

function eqC(actual, expected, label) {
  eqBits(actual[0], expected.re, `${label}.re`);
  eqBits(actual[1], expected.im, `${label}.im`);
}

const unaryFns = {
  abs: mathx.cAbs,
  arg: mathx.cArg,
  norm: mathx.cNorm,
};
const unaryC = {
  conj: mathx.cConj,
  exp: mathx.cExp,
  log: mathx.cLog,
  log10: mathx.cLog10,
  sqrt: mathx.cSqrt,
  sin: mathx.cSin,
  cos: mathx.cCos,
  tan: mathx.cTan,
  sinh: mathx.cSinh,
  cosh: mathx.cCosh,
  tanh: mathx.cTanh,
  asin: mathx.cAsin,
  acos: mathx.cAcos,
  atan: mathx.cAtan,
  asinh: mathx.cAsinh,
  acosh: mathx.cAcosh,
  atanh: mathx.cAtanh,
  cot: mathx.cCot,
};

test('math/cmplx required signed-zero / Inf cases', () => {
  const packet = goOracle();
  eqC(mathx.cSqrt([-1, 0]), packet.sqrtNeg1, 'sqrt(-1+0i)');
  eqC(mathx.cLog10([-1, 0]), packet.log10Neg1, 'log10(-1+0i)');
  eqBits(mathx.cPolar([-1, 0]).r, packet.polarNeg1R, 'polar(-1).r');
  eqBits(mathx.cPolar([-1, 0]).φ, packet.polarNeg1Phi, 'polar(-1).φ');
  assert.equal(mathx.cSqrt([-1, 0])[0], 0);
  assert.equal(mathx.cSqrt([-1, 0])[1], 1);
  assert.equal(mathx.cPolar([-1, 0]).r, 1);
  assert.equal(mathx.cPolar([-1, 0]).φ, Math.PI);
  eqC(mathx.cInf(), packet.inf, 'cInf');
  eqC(mathx.cNaN(), packet.nanC, 'cNaN');
  assert.equal(mathx.cIsInf([Infinity, 0]), true);
  assert.equal(mathx.cIsInf([1, 2]), false);
  assert.equal(mathx.cIsInf([Infinity, 0], 1), true);
  assert.equal(mathx.cIsInf([Infinity, 0], -1), false);
  assert.equal(mathx.cIsInf([-Infinity, 0], -1), true);
  assert.equal(mathx.cIsNaN([NaN, 1]), true);
  assert.equal(mathx.cIsNaN([Infinity, NaN]), false);
  assert.throws(() => mathx.cAbs(1), TypeError);
  assert.throws(() => mathx.cIsInf([0, 0], 1.5), RangeError);
});

test('math/cmplx matches Go float64 bit patterns (cartesian specials + seeded random)', () => {
  const packet = goOracle();
  for (let i = 0; i < packet.unary.length; i++) {
    const row = packet.unary[i];
    const z = C(row.in);
    const tag = `z=${row.in.re},${row.in.im}`;
    for (const [name, fn] of Object.entries(unaryFns)) {
      eqBits(fn(z), row[name], `${name}(${tag})`);
    }
    for (const [name, fn] of Object.entries(unaryC)) {
      eqC(fn(z), row[name], `${name}(${tag})`);
    }
    const polar = mathx.cPolar(z);
    eqBits(polar.r, row.polarR, `polar.r(${tag})`);
    eqBits(polar.φ, row.polarPhi, `polar.φ(${tag})`);
    assert.equal(mathx.cIsInf(z), row.isInf0, `isInf ${tag}`);
    assert.equal(mathx.cIsInf(z, 1), row.isInfPos, `isInf+ ${tag}`);
    assert.equal(mathx.cIsInf(z, -1), row.isInfNeg, `isInf- ${tag}`);
    assert.equal(mathx.cIsNaN(z), row.isNaN, `isNaN ${tag}`);
  }
  for (let i = 0; i < packet.pow.length; i++) {
    const row = packet.pow[i];
    eqC(mathx.cPow(C(row.x), C(row.y)), row.out, `pow ${row.x.re}+${row.x.im}i ** ${row.y.re}+${row.y.im}i`);
  }
  for (const row of packet.rect) {
    eqC(mathx.cRect(fromBits(row.r), fromBits(row.phi)), { re: row.re, im: row.im }, `rect ${row.r} ${row.phi}`);
  }

  const diffs = globalThis.__cmplxDiffs ?? [];
  const byKind = {};
  for (const d of diffs) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  const semantic = diffs.filter(d => d.kind !== 'libm-ulp');
  const sample = semantic.slice(0, 40).map(d => `${d.kind} ${d.label}: go=${d.expected} ours=${d.actual} ulp=${d.ulp}`).join('\n');
  assert.equal(semantic.length, 0, `${JSON.stringify(byKind)}\n${sample}`);

  const ulp = diffs.filter(d => d.kind === 'libm-ulp');
  const max = ulp.reduce((m, d) => Math.max(m, d.ulp ?? 0), 0);
  assert.ok(max < 1024, `unexpected huge libm gap max=${max} count=${ulp.length}`);
});
