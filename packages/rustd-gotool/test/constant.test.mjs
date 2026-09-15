import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  GoConstValue,
  constMakeInt64,
  constMakeBool,
  constMakeFromLiteral,
  constToFloat,
  constToComplex,
  constToIntValue,
  constToInt,
  constToString,
  constBoolVal,
  constFloat64Val,
  constCompare,
  constCompareOp,
  constSign,
  constReal,
  constImag,
  constBitLen,
  constBinaryOp,
  constUnaryOp,
  constShift,
  TOKEN,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/gotool', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20, timeout: 120000,
  });
}

function evaluate(c) {
  const x = constMakeInt64(BigInt(c.x));
  const y = constMakeInt64(BigInt(c.y));
  const [toInt, toIntOk] = constToInt(x);
  return {
    ...c,
    kind: x.kind,
    toInt: toInt.toString(),
    toIntOk,
    sign: constSign(x),
    bitLen: constBitLen(x),
    compare: constCompare(x, y),
  };
}

test('Go 1.24 regenerates committed go/constant Int fixtures; native matches every case', () => {
  const generated = go(['-constant']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-int');
  assert.ok(fixture.cases.length >= 17 * 17, `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluate(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.toInt, c.toInt, `${c.id} toInt`);
    assert.equal(got.toIntOk, c.toIntOk, `${c.id} toIntOk`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.bitLen, c.bitLen, `${c.id} bitLen`);
    assert.equal(got.compare, c.compare, `${c.id} compare ${c.x} ${c.y}`);
  }
});

test('JS MakeInt64 extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    0n, 1n, -1n, 3n, -3n, 99n, -(1n << 31n), (1n << 31n) - 1n, (1n << 63n) - 1n, -(1n << 63n),
  ];
  const cases = [];
  for (let i = 0; i < extras.length; i++) {
    for (let j = 0; j < extras.length; j++) {
      cases.push(evaluate({
        id: `js-${i}-${j}`,
        x: extras[i].toString(),
        y: extras[j].toString(),
      }));
    }
  }
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-int', cases };
  const verified = go(['-verify-constant'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 100 gotool constant-int cases/);
  const broken = structuredClone(packet);
  broken.cases[1].compare = 99;
  const rejected = go(['-verify-constant'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-int', cases: [],
  })).status, 0);
});

function evaluateBin(c) {
  const r = constBinaryOp(TOKEN[c.op], constMakeInt64(BigInt(c.x)), constMakeInt64(BigInt(c.y)));
  const [toInt, toIntOk] = constToInt(r);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    toInt: toInt.toString(),
    toIntOk,
    sign: constSign(r),
    bitLen: r.kind === 'Int' ? constBitLen(r) : 0,
  };
}

test('Go 1.24 regenerates committed go/constant Int BinaryOp fixtures; native matches every case', () => {
  const generated = go(['-constant-binop']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-binop-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go BinaryOp fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-int-binop');
  assert.ok(fixture.cases.length >= 8 * (17 * 17 - 17), `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluateBin(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.toInt, c.toInt, `${c.id} toInt`);
    assert.equal(got.toIntOk, c.toIntOk, `${c.id} toIntOk`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.bitLen, c.bitLen, `${c.id} bitLen`);
    assert.equal(got.opTok, TOKEN[c.op], `${c.id} opTok`);
  }
});

test('JS BinaryOp extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    0n, 1n, -1n, 3n, -3n, (1n << 31n) - 1n, -(1n << 31n), (1n << 63n) - 1n, -(1n << 63n),
  ];
  const ops = ['ADD', 'SUB', 'MUL', 'QUO', 'REM', 'AND', 'OR', 'XOR'];
  const cases = [];
  for (const op of ops) {
    for (let i = 0; i < extras.length; i++) {
      for (let j = 0; j < extras.length; j++) {
        if ((op === 'QUO' || op === 'REM') && extras[j] === 0n) continue;
        cases.push(evaluateBin({
          id: `js-${op}-${i}-${j}`,
          op,
          opTok: TOKEN[op],
          x: extras[i].toString(),
          y: extras[j].toString(),
        }));
      }
    }
  }
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-int-binop', cases };
  const verified = go(['-verify-constant-binop'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ gotool constant-int-binop cases/);
  const broken = structuredClone(packet);
  broken.cases[1].exact = 'not-a-number';
  const rejected = go(['-verify-constant-binop'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant-binop'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-int-binop', cases: [],
  })).status, 0);
});

test('constBinaryOp QUO/REM by zero is Unknown; Unknown propagates; invalid op throws', () => {
  const z = constMakeInt64(0n);
  const one = constMakeInt64(1n);
  const quo = constBinaryOp(TOKEN.QUO, one, z);
  const rem = constBinaryOp(TOKEN.REM, one, z);
  assert.equal(quo.kind, 'Unknown');
  assert.equal(rem.kind, 'Unknown');
  assert.equal(quo.toString(), 'unknown');
  assert.equal(constSign(quo), 1);
  assert.equal(constBitLen(quo), 0);
  assert.equal(constToInt(quo)[1], false);
  assert.equal(constBinaryOp(TOKEN.ADD, quo, one).kind, 'Unknown');
  assert.equal(constBinaryOp(TOKEN.XOR, one, rem).kind, 'Unknown');
  assert.throws(() => constCompare(quo, one), /Unknown/);
  assert.throws(() => constBinaryOp(TOKEN.SHL, one, one), /ADD/);
  assert.throws(() => constBinaryOp(TOKEN.ADD, 1, one), TypeError);
  const overflow = constBinaryOp(TOKEN.ADD, constMakeInt64((1n << 63n) - 1n), one);
  assert.equal(overflow.kind, 'Int');
  assert.equal(overflow.toString(), (1n << 63n).toString());
  const [ov, ok] = constToInt(overflow);
  assert.equal(ok, false);
  assert.equal(ov, -(1n << 63n));
  assert.equal(constBitLen(overflow), 64);
});

function evaluateUS(c) {
  const x = constMakeInt64(BigInt(c.x));
  let r;
  if (c.form === 'unary') r = constUnaryOp(TOKEN[c.op], x, c.prec);
  else if (c.form === 'andnot') r = constBinaryOp(TOKEN.AND_NOT, x, constMakeInt64(BigInt(c.y)));
  else if (c.form === 'shift') r = constShift(TOKEN[c.op], x, BigInt(c.s));
  else throw new Error(`unknown form ${c.form}`);
  const [toInt, toIntOk] = constToInt(r);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    toInt: toInt.toString(),
    toIntOk,
    sign: constSign(r),
    bitLen: r.kind === 'Int' ? constBitLen(r) : 0,
  };
}

test('Go 1.24 regenerates committed go/constant Int UnaryOp/AND_NOT/Shift fixtures; native matches every case', () => {
  const generated = go(['-constant-unary-shift']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-unary-shift-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go UnaryOp/AND_NOT/Shift fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-int-unary-shift');
  assert.ok(fixture.cases.length >= 34 + 102 + 289 + 272, `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluateUS(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.toInt, c.toInt, `${c.id} toInt`);
    assert.equal(got.toIntOk, c.toIntOk, `${c.id} toIntOk`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.bitLen, c.bitLen, `${c.id} bitLen`);
    assert.equal(got.opTok, TOKEN[c.op], `${c.id} opTok`);
  }
});

test('JS UnaryOp/AND_NOT/Shift extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [0n, 1n, -1n, 5n, -5n, (1n << 63n) - 1n, -(1n << 63n)];
  const cases = [];
  for (const op of ['ADD', 'SUB']) {
    for (let i = 0; i < extras.length; i++) {
      cases.push(evaluateUS({
        id: `js-unary-${op}-${i}`, form: 'unary', op, opTok: TOKEN[op],
        x: extras[i].toString(), y: '0', s: '0', prec: 0,
      }));
    }
  }
  for (const prec of [0, 8, 64]) {
    for (let i = 0; i < extras.length; i++) {
      cases.push(evaluateUS({
        id: `js-unary-XOR-p${prec}-${i}`, form: 'unary', op: 'XOR', opTok: TOKEN.XOR,
        x: extras[i].toString(), y: '0', s: '0', prec,
      }));
    }
  }
  for (let i = 0; i < extras.length; i++) {
    for (let j = 0; j < extras.length; j++) {
      cases.push(evaluateUS({
        id: `js-andnot-${i}-${j}`, form: 'andnot', op: 'AND_NOT', opTok: TOKEN.AND_NOT,
        x: extras[i].toString(), y: extras[j].toString(), s: '0', prec: 0,
      }));
    }
  }
  for (const op of ['SHL', 'SHR']) {
    for (const s of [0n, 1n, 63n, 64n]) {
      for (let i = 0; i < extras.length; i++) {
        cases.push(evaluateUS({
          id: `js-shift-${op}-s${s}-${i}`, form: 'shift', op, opTok: TOKEN[op],
          x: extras[i].toString(), y: '0', s: s.toString(), prec: 0,
        }));
      }
    }
  }
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-int-unary-shift', cases };
  const verified = go(['-verify-constant-unary-shift'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ gotool constant-int-unary-shift cases/);
  const broken = structuredClone(packet);
  broken.cases[1].exact = 'not-a-number';
  const rejected = go(['-verify-constant-unary-shift'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant-unary-shift'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-int-unary-shift', cases: [],
  })).status, 0);
});

test('constUnaryOp/constShift Unknown, invalid op/prec/s, AND_NOT vs SHL BinaryOp', () => {
  const z = constMakeInt64(0n);
  const one = constMakeInt64(1n);
  const unk = constBinaryOp(TOKEN.QUO, one, z);
  assert.equal(constUnaryOp(TOKEN.XOR, unk, 0).kind, 'Unknown');
  assert.equal(constUnaryOp(TOKEN.ADD, unk, 0).kind, 'Unknown');
  assert.equal(constShift(TOKEN.SHL, unk, 3n).kind, 'Unknown');
  assert.equal(constBinaryOp(TOKEN.AND_NOT, unk, one).kind, 'Unknown');
  assert.equal(constUnaryOp(TOKEN.XOR, z, 8).toString(), '255');
  assert.equal(constUnaryOp(TOKEN.SUB, constMakeInt64(-(1n << 63n)), 0).toString(), (1n << 63n).toString());
  assert.equal(constShift(TOKEN.SHR, constMakeInt64(-1n), 64n).toString(), '-1');
  assert.equal(constBinaryOp(TOKEN.AND_NOT, constMakeInt64(7n), one).toString(), '6');
  assert.throws(() => constUnaryOp(TOKEN.NOT, one, 0), /NOT requires Bool/);
  assert.throws(() => constUnaryOp(TOKEN.XOR, one, -1), TypeError);
  assert.throws(() => constUnaryOp(TOKEN.XOR, one, 1.5), TypeError);
  assert.throws(() => constShift(TOKEN.ADD, one, 1n), /SHL/);
  assert.throws(() => constShift(TOKEN.SHL, one, -1n), /0\.\.1000000/);
  assert.throws(() => constShift(TOKEN.SHL, one, 1), TypeError);
  assert.throws(() => constBinaryOp(TOKEN.SHL, one, one), /ADD/);
});

function f64BitsHex(n) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = n;
  return new BigUint64Array(buf)[0].toString(16).padStart(16, '0');
}

function evaluateVal(c) {
  let r;
  if (c.form === 'int') r = constMakeInt64(BigInt(c.x));
  else if (c.form === 'quo') r = constBinaryOp(TOKEN.QUO, constMakeInt64(BigInt(c.x)), constMakeInt64(BigInt(c.y)));
  else if (c.form === 'shift') r = constShift(TOKEN.SHL, constMakeInt64(BigInt(c.x)), BigInt(c.s));
  else if (c.form === 'shift-quo') {
    r = constBinaryOp(
      TOKEN.QUO,
      constMakeInt64(BigInt(c.x)),
      constShift(TOKEN.SHL, constMakeInt64(1n), BigInt(c.s)),
    );
  } else if (c.form === 'unknown') r = constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(0n));
  else throw new Error(`unknown form ${c.form}`);
  const [toString, toStringOk] = constToString(r);
  const [f, f64Exact] = constFloat64Val(r);
  return {
    ...c,
    kind: r.kind,
    toString,
    toStringOk,
    f64Bits: f64BitsHex(f),
    f64Exact,
  };
}

test('Go 1.24 regenerates committed go/constant Int/Float StringVal+Float64Val fixtures; native matches every case', () => {
  const generated = go(['-constant-val']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-val-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go StringVal/Float64Val fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-int-float-val');
  assert.ok(fixture.cases.length >= 17 + 17 * 16, `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluateVal(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.toString, c.toString, `${c.id} toString`);
    assert.equal(got.toStringOk, c.toStringOk, `${c.id} toStringOk`);
    assert.equal(got.f64Bits, c.f64Bits, `${c.id} f64Bits`);
    assert.equal(got.f64Exact, c.f64Exact, `${c.id} f64Exact`);
  }
});

test('JS StringVal/Float64Val extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [0n, 1n, -1n, 3n, (1n << 53n) - 1n, 1n << 53n, (1n << 63n) - 1n, -(1n << 63n)];
  const cases = [];
  for (let i = 0; i < extras.length; i++) {
    cases.push(evaluateVal({
      id: `js-val-int-${i}`, form: 'int', x: extras[i].toString(), y: '0', s: '0',
    }));
  }
  for (const y of [1n, -1n, 3n, 7n]) {
    for (let i = 0; i < extras.length; i++) {
      cases.push(evaluateVal({
        id: `js-val-quo-${i}-${y}`, form: 'quo', x: extras[i].toString(), y: y.toString(), s: '0',
      }));
    }
  }
  for (const s of [0n, 1n, 53n, 64n]) {
    cases.push(evaluateVal({
      id: `js-val-shl-${s}`, form: 'shift', x: '1', y: '0', s: s.toString(),
    }));
    cases.push(evaluateVal({
      id: `js-val-quo-shl-${s}`, form: 'shift-quo', x: '1', y: '0', s: s.toString(),
    }));
  }
  cases.push(evaluateVal({ id: 'js-val-unknown', form: 'unknown', x: '1', y: '0', s: '0' }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-int-float-val', cases };
  const verified = go(['-verify-constant-val'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ gotool constant-int-float-val cases/);
  const broken = structuredClone(packet);
  broken.cases[1].f64Bits = 'ffffffffffffffff';
  const rejected = go(['-verify-constant-val'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant-val'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-int-float-val', cases: [],
  })).status, 0);
});

function makeCmpVal(form, x, y, s) {
  if (form === 'int') return constMakeInt64(BigInt(x));
  if (form === 'quo') return constBinaryOp(TOKEN.QUO, constMakeInt64(BigInt(x)), constMakeInt64(BigInt(y)));
  if (form === 'shift-quo') {
    return constBinaryOp(
      TOKEN.QUO,
      constMakeInt64(BigInt(x)),
      constShift(TOKEN.SHL, constMakeInt64(1n), BigInt(s)),
    );
  }
  throw new Error(`unknown form ${form}`);
}

function evaluateFCmp(c) {
  const vx = makeCmpVal(c.formX, c.xx, c.xy, c.xs);
  const vy = makeCmpVal(c.formY, c.yx, c.yy, c.ys);
  return {
    ...c,
    kindX: vx.kind,
    kindY: vy.kind,
    exactX: vx.toString(),
    exactY: vy.toString(),
    compare: constCompare(vx, vy),
  };
}

test('Go 1.24 regenerates committed go/constant Float constCompare fixtures; native matches every case', () => {
  const generated = go(['-constant-float-compare']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-float-compare-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go Float constCompare fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-float-compare');
  assert.ok(fixture.cases.length >= 32 * 32, `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluateFCmp(c);
    assert.equal(got.kindX, c.kindX, `${c.id} kindX`);
    assert.equal(got.kindY, c.kindY, `${c.id} kindY`);
    assert.equal(got.exactX, c.exactX, `${c.id} exactX`);
    assert.equal(got.exactY, c.exactY, `${c.id} exactY`);
    assert.equal(got.compare, c.compare, `${c.id} compare`);
  }
});

test('JS Float constCompare extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { form: 'int', x: '0', y: '0', s: '0' },
    { form: 'int', x: '1', y: '0', s: '0' },
    { form: 'int', x: '-1', y: '0', s: '0' },
    { form: 'quo', x: '1', y: '2', s: '0' },
    { form: 'quo', x: '2', y: '4', s: '0' },
    { form: 'quo', x: '-1', y: '2', s: '0' },
    { form: 'quo', x: '22', y: '7', s: '0' },
    { form: 'shift-quo', x: '1', y: '0', s: '53' },
  ];
  const cases = [];
  for (let i = 0; i < extras.length; i++) {
    for (let j = 0; j < extras.length; j++) {
      cases.push(evaluateFCmp({
        id: `js-fcmp-${i}-${j}`,
        formX: extras[i].form, xx: extras[i].x, xy: extras[i].y, xs: extras[i].s,
        formY: extras[j].form, yx: extras[j].x, yy: extras[j].y, ys: extras[j].s,
      }));
    }
  }
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-float-compare', cases };
  const verified = go(['-verify-constant-float-compare'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 64 gotool constant-float-compare cases/);
  const broken = structuredClone(packet);
  broken.cases[1].compare = 99;
  const rejected = go(['-verify-constant-float-compare'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant-float-compare'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-float-compare', cases: [],
  })).status, 0);
});

function evaluateFBin(c) {
  const vx = makeCmpVal(c.formX, c.xx, c.xy, c.xs);
  const vy = makeCmpVal(c.formY, c.yx, c.yy, c.ys);
  const r = constBinaryOp(TOKEN[c.op], vx, vy);
  const [f, f64Exact] = constFloat64Val(r);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    sign: constSign(r),
    f64Bits: f64BitsHex(f),
    f64Exact,
  };
}

test('Go 1.24 regenerates committed go/constant Float BinaryOp fixtures; native matches every case', () => {
  const generated = go(['-constant-float-binop']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-float-binop-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go Float BinaryOp fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-float-binop');
  assert.ok(fixture.cases.length >= 4 * 32 * 32 - 64, `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluateFBin(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.f64Bits, c.f64Bits, `${c.id} f64Bits`);
    assert.equal(got.f64Exact, c.f64Exact, `${c.id} f64Exact`);
    assert.equal(got.opTok, TOKEN[c.op], `${c.id} opTok`);
  }
});

test('JS Float BinaryOp extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { form: 'int', x: '0', y: '0', s: '0' },
    { form: 'int', x: '1', y: '0', s: '0' },
    { form: 'int', x: '-1', y: '0', s: '0' },
    { form: 'quo', x: '1', y: '2', s: '0' },
    { form: 'quo', x: '2', y: '4', s: '0' },
    { form: 'quo', x: '-1', y: '2', s: '0' },
    { form: 'quo', x: '22', y: '7', s: '0' },
    { form: 'shift-quo', x: '1', y: '0', s: '53' },
  ];
  const ops = ['ADD', 'SUB', 'MUL', 'QUO'];
  const cases = [];
  for (const op of ops) {
    for (let i = 0; i < extras.length; i++) {
      for (let j = 0; j < extras.length; j++) {
        if (op === 'QUO' && extras[j].form === 'int' && extras[j].x === '0') continue;
        cases.push(evaluateFBin({
          id: `js-fbin-${op}-${i}-${j}`,
          op,
          opTok: TOKEN[op],
          formX: extras[i].form, xx: extras[i].x, xy: extras[i].y, xs: extras[i].s,
          formY: extras[j].form, yx: extras[j].x, yy: extras[j].y, ys: extras[j].s,
        }));
      }
    }
  }
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-float-binop', cases };
  const verified = go(['-verify-constant-float-binop'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ gotool constant-float-binop cases/);
  const broken = structuredClone(packet);
  broken.cases[1].exact = 'not-a-number';
  const rejected = go(['-verify-constant-float-binop'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant-float-binop'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-float-binop', cases: [],
  })).status, 0);
});

function evaluateFUn(c) {
  const vy = makeCmpVal(c.formY, c.yx, c.yy, c.ys);
  const r = constUnaryOp(TOKEN[c.op], vy, 0);
  const [f, f64Exact] = constFloat64Val(r);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    sign: constSign(r),
    f64Bits: f64BitsHex(f),
    f64Exact,
  };
}

test('Go 1.24 regenerates committed go/constant Float UnaryOp fixtures; native matches every case', () => {
  const generated = go(['-constant-float-unary']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-float-unary-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go Float UnaryOp fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-float-unary');
  assert.ok(fixture.cases.length >= 2 * 32, `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluateFUn(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.f64Bits, c.f64Bits, `${c.id} f64Bits`);
    assert.equal(got.f64Exact, c.f64Exact, `${c.id} f64Exact`);
    assert.equal(got.opTok, TOKEN[c.op], `${c.id} opTok`);
  }
});

test('JS Float UnaryOp extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { form: 'int', x: '0', y: '0', s: '0' },
    { form: 'int', x: '1', y: '0', s: '0' },
    { form: 'int', x: '-1', y: '0', s: '0' },
    { form: 'quo', x: '1', y: '2', s: '0' },
    { form: 'quo', x: '2', y: '4', s: '0' },
    { form: 'quo', x: '-1', y: '2', s: '0' },
    { form: 'quo', x: '22', y: '7', s: '0' },
    { form: 'shift-quo', x: '1', y: '0', s: '53' },
  ];
  const ops = ['ADD', 'SUB'];
  const cases = [];
  for (const op of ops) {
    for (let i = 0; i < extras.length; i++) {
      cases.push(evaluateFUn({
        id: `js-fun-${op}-${i}`,
        op,
        opTok: TOKEN[op],
        formY: extras[i].form, yx: extras[i].x, yy: extras[i].y, ys: extras[i].s,
      }));
    }
  }
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-float-unary', cases };
  const verified = go(['-verify-constant-float-unary'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ gotool constant-float-unary cases/);
  const broken = structuredClone(packet);
  broken.cases[1].exact = 'not-a-number';
  const rejected = go(['-verify-constant-float-unary'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant-float-unary'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-float-unary', cases: [],
  })).status, 0);
});

test('constUnaryOp Float: +1/2 is 1/2; -1/2 is -1/2; integer-valued Float stays Float; XOR throws', () => {
  const half = constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(2n));
  const one = constMakeInt64(1n);
  const pos = constUnaryOp(TOKEN.ADD, half, 0);
  assert.equal(pos.kind, 'Float');
  assert.equal(pos.toString(), '1/2');
  assert.equal(constCompare(pos, half), 0);
  const neg = constUnaryOp(TOKEN.SUB, half, 0);
  assert.equal(neg.kind, 'Float');
  assert.equal(neg.toString(), '-1/2');
  assert.equal(constCompare(neg, half), -1);
  const sum = constBinaryOp(TOKEN.ADD, half, half);
  assert.equal(sum.kind, 'Float');
  assert.equal(constUnaryOp(TOKEN.ADD, sum, 0).kind, 'Float');
  assert.equal(constUnaryOp(TOKEN.ADD, sum, 0).toString(), '1');
  assert.equal(constUnaryOp(TOKEN.SUB, sum, 0).toString(), '-1');
  assert.equal(constUnaryOp(TOKEN.SUB, constUnaryOp(TOKEN.SUB, half, 0), 0).toString(), '1/2');
  assert.equal(constUnaryOp(TOKEN.ADD, one, 0).kind, 'Int');
  const unk = constBinaryOp(TOKEN.QUO, half, constMakeInt64(0n));
  assert.equal(constUnaryOp(TOKEN.SUB, unk, 0).kind, 'Unknown');
  assert.throws(() => constUnaryOp(TOKEN.XOR, half, 0), /Int/);
  assert.throws(() => constUnaryOp(TOKEN.XOR, half, 8), /Int/);
});

test('constBinaryOp Float: 1/2+1/2 is Float 1; mixed Int+Float; QUO-0 Unknown; REM throws', () => {
  const half = constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(2n));
  const twoOverFour = constBinaryOp(TOKEN.QUO, constMakeInt64(2n), constMakeInt64(4n));
  const one = constMakeInt64(1n);
  const z = constMakeInt64(0n);
  const sum = constBinaryOp(TOKEN.ADD, half, twoOverFour);
  assert.equal(sum.kind, 'Float');
  assert.equal(sum.toString(), '1');
  assert.equal(constCompare(sum, one), 0);
  const mixed = constBinaryOp(TOKEN.ADD, one, half);
  assert.equal(mixed.kind, 'Float');
  assert.equal(mixed.toString(), '3/2');
  assert.equal(constBinaryOp(TOKEN.MUL, half, constMakeInt64(4n)).toString(), '2');
  assert.equal(constBinaryOp(TOKEN.SUB, half, half).toString(), '0');
  const unk = constBinaryOp(TOKEN.QUO, half, z);
  assert.equal(unk.kind, 'Unknown');
  assert.equal(constBinaryOp(TOKEN.ADD, unk, half).kind, 'Unknown');
  assert.throws(() => constBinaryOp(TOKEN.REM, half, one), /Int/);
  assert.throws(() => constBinaryOp(TOKEN.AND, half, one), /Int/);
  assert.throws(() => constBinaryOp(TOKEN.XOR, one, half), /Int/);
});

test('constCompare Float vs Int uses exact Rat; 2/4 ≡ 1/2; Unknown still throws', () => {
  const half = constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(2n));
  const twoOverFour = constBinaryOp(TOKEN.QUO, constMakeInt64(2n), constMakeInt64(4n));
  const one = constMakeInt64(1n);
  const two = constMakeInt64(2n);
  assert.equal(half.kind, 'Float');
  assert.equal(constCompare(half, twoOverFour), 0);
  assert.equal(constCompare(twoOverFour, half), 0);
  assert.equal(constCompare(half, one), -1);
  assert.equal(constCompare(one, half), 1);
  assert.equal(constCompare(constBinaryOp(TOKEN.QUO, two, one), two), 0);
  const unk = constBinaryOp(TOKEN.QUO, one, constMakeInt64(0n));
  assert.throws(() => constCompare(unk, one), /Unknown/);
  assert.throws(() => constCompare(half, unk), /Unknown/);
});

test('constToString Int/Float is not StringVal; Unknown is empty+ok; Float64Val signed zero', () => {
  const one = constMakeInt64(1n);
  const z = constMakeInt64(0n);
  assert.deepEqual(constToString(one), ['', false]);
  assert.deepEqual(constToString(constBinaryOp(TOKEN.QUO, one, constMakeInt64(2n))), ['', false]);
  const unk = constBinaryOp(TOKEN.QUO, one, z);
  assert.equal(unk.kind, 'Unknown');
  assert.deepEqual(constToString(unk), ['', true]);
  assert.deepEqual(constFloat64Val(unk), [0, false]);
  const [zero, zeroExact] = constFloat64Val(z);
  assert.equal(zero, 0);
  assert.equal(Object.is(zero, -0), false);
  assert.equal(zeroExact, true);
  assert.throws(() => constToString(1), TypeError);
  assert.throws(() => constFloat64Val(null), TypeError);
});

function evaluateLit(c) {
  const r = constMakeFromLiteral(c.lit, TOKEN[c.tok], 0);
  const [toInt, toIntOk] = constToInt(r);
  const [f, f64Exact] = constFloat64Val(r);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    sign: constSign(r),
    toInt: toInt.toString(),
    toIntOk,
    bitLen: r.kind === 'Int' ? constBitLen(r) : 0,
    f64Bits: f64BitsHex(f),
    f64Exact,
  };
}

test('Go 1.24 regenerates committed go/constant MakeFromLiteral Int/Float fixtures; native matches every case', () => {
  const generated = go(['-constant-literal']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-literal-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go MakeFromLiteral fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-int-float-literal');
  assert.ok(fixture.cases.length >= 40 + 40, `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluateLit(c);
    assert.equal(got.kind, c.kind, `${c.id} kind lit=${c.lit}`);
    assert.equal(got.exact, c.exact, `${c.id} exact lit=${c.lit}`);
    assert.equal(got.sign, c.sign, `${c.id} sign lit=${c.lit}`);
    assert.equal(got.toInt, c.toInt, `${c.id} toInt lit=${c.lit}`);
    assert.equal(got.toIntOk, c.toIntOk, `${c.id} toIntOk lit=${c.lit}`);
    assert.equal(got.bitLen, c.bitLen, `${c.id} bitLen lit=${c.lit}`);
    assert.equal(got.f64Bits, c.f64Bits, `${c.id} f64Bits lit=${c.lit}`);
    assert.equal(got.f64Exact, c.f64Exact, `${c.id} f64Exact lit=${c.lit}`);
    assert.equal(got.tokNum, TOKEN[c.tok], `${c.id} tokNum`);
  }
});

test('JS MakeFromLiteral extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { tok: 'INT', lit: '0' },
    { tok: 'INT', lit: '-99' },
    { tok: 'INT', lit: '0xFF' },
    { tok: 'INT', lit: '0b_1111' },
    { tok: 'INT', lit: '0o77' },
    { tok: 'INT', lit: '1_000_000' },
    { tok: 'INT', lit: '08' },
    { tok: 'FLOAT', lit: '2.5' },
    { tok: 'FLOAT', lit: '-0.25' },
    { tok: 'FLOAT', lit: '1e-10' },
    { tok: 'FLOAT', lit: '0x1.8p4' },
    { tok: 'FLOAT', lit: '1e+1000000000' },
  ];
  const cases = extras.map((c, i) => evaluateLit({
    id: `js-lit-${i}`, tok: c.tok, tokNum: TOKEN[c.tok], lit: c.lit,
  }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-int-float-literal', cases };
  const verified = go(['-verify-constant-literal'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 12 gotool constant-int-float-literal cases/);
  const broken = structuredClone(packet);
  broken.cases[1].exact = 'not-a-number';
  const rejected = go(['-verify-constant-literal'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant-literal'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-int-float-literal', cases: [],
  })).status, 0);
});

test('constMakeFromLiteral: 0x10 is Int 16; 1.5 is Float 3/2; invalid is Unknown; prec/tok throw', () => {
  const hex = constMakeFromLiteral('0x10', TOKEN.INT, 0);
  assert.equal(hex.kind, 'Int');
  assert.equal(hex.toString(), '16');
  assert.equal(constCompare(hex, constMakeInt64(16n)), 0);
  const half = constMakeFromLiteral('1.5', TOKEN.FLOAT, 0);
  assert.equal(half.kind, 'Float');
  assert.equal(half.toString(), '3/2');
  assert.equal(constCompare(half, constBinaryOp(TOKEN.QUO, constMakeInt64(3n), constMakeInt64(2n))), 0);
  const unk = constMakeFromLiteral('08', TOKEN.INT, 0);
  assert.equal(unk.kind, 'Unknown');
  assert.equal(unk.toString(), 'unknown');
  assert.equal(constMakeFromLiteral('1e+1000000000', TOKEN.FLOAT, 0).kind, 'Unknown');
  assert.equal(constMakeFromLiteral('1e-1000000000', TOKEN.FLOAT, 0).toString(), '0');
  assert.throws(() => constMakeFromLiteral('1', TOKEN.INT, 1), /prec must be 0/);
  assert.throws(() => constMakeFromLiteral('1', TOKEN.INT, 0.5), TypeError);
  assert.equal(constMakeFromLiteral('1', TOKEN.STRING, 0).kind, 'Unknown');
  assert.equal(constMakeFromLiteral('1', TOKEN.IMAG, 0).kind, 'Unknown');
  assert.throws(() => constMakeFromLiteral('1', TOKEN.ADD, 0), /INT, FLOAT, CHAR, IMAG, or STRING/);
  assert.throws(() => constMakeFromLiteral(1, TOKEN.INT, 0), TypeError);
});

test('Go 1.24 regenerates committed go/constant MakeFromLiteral CHAR fixtures; native matches every case', () => {
  const generated = go(['-constant-char-literal']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-char-literal-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go MakeFromLiteral CHAR fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-char-literal');
  assert.ok(fixture.cases.length >= 40, `too few CHAR cases: ${fixture.cases.length}`);
  const unknown = fixture.cases.filter((c) => c.kind === 'Unknown');
  assert.ok(unknown.length >= 3, `need malformed CHAR cases, got ${unknown.length}`);
  for (const c of fixture.cases) {
    const got = evaluateLit(c);
    assert.equal(got.kind, c.kind, `${c.id} kind lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.exact, c.exact, `${c.id} exact lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.sign, c.sign, `${c.id} sign lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.toInt, c.toInt, `${c.id} toInt lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.toIntOk, c.toIntOk, `${c.id} toIntOk lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.bitLen, c.bitLen, `${c.id} bitLen lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.f64Bits, c.f64Bits, `${c.id} f64Bits lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.f64Exact, c.f64Exact, `${c.id} f64Exact lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.tokNum, TOKEN.CHAR, `${c.id} tokNum`);
  }
});

test('JS MakeFromLiteral CHAR extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    "'z'",
    "'\\n'",
    "'\\x41'",
    "'中'",
    "'ab'",
    "''",
    "'\\uD800'",
    "'\\400'",
    "'\\\"'",
    '"a"',
    '`a`',
    "'a'x",
    "'''",
    'aa',
    "'\\uFFFE'",
    "'\\uFDD0'",
    "'\n'",
    "'\0'",
    'a b',
    "''''",
    '中',
    'π',
    '😀',
    'é',
    '"中"',
    '`中`',
    '"\'"',
    "'\\U0001FFFE'",
    '"\\n"',
    '"a"x',
  ];
  const cases = extras.map((lit, i) => evaluateLit({
    id: `js-char-${i}`, tok: 'CHAR', tokNum: TOKEN.CHAR, lit,
  }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-char-literal', cases };
  const verified = go(['-verify-constant-char-literal'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 30 gotool constant-char-literal cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-a-rune';
  const rejected = go(['-verify-constant-char-literal'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-char-literal'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-char-literal', cases: [],
  })).status, 0);
});

test('constMakeFromLiteral CHAR: rune Int, tail ignored, malformed Unknown', () => {
  const a = constMakeFromLiteral("'a'", TOKEN.CHAR, 0);
  assert.equal(a.kind, 'Int');
  assert.equal(a.toString(), '97');
  assert.equal(constCompare(a, constMakeInt64(97n)), 0);
  const nl = constMakeFromLiteral("'\\n'", TOKEN.CHAR, 0);
  assert.equal(nl.toString(), '10');
  const extra = constMakeFromLiteral("'ab'", TOKEN.CHAR, 0);
  assert.equal(extra.toString(), '97');
  const empty = constMakeFromLiteral("''", TOKEN.CHAR, 0);
  assert.equal(empty.kind, 'Unknown');
  const surrogate = constMakeFromLiteral("'\\uD800'", TOKEN.CHAR, 0);
  assert.equal(surrogate.kind, 'Unknown');
  const octal = constMakeFromLiteral("'\\400'", TOKEN.CHAR, 0);
  assert.equal(octal.kind, 'Unknown');
  const stripped = constMakeFromLiteral('"a"', TOKEN.CHAR, 0);
  assert.equal(stripped.toString(), '97');
  const emptyInner = constMakeFromLiteral('aa', TOKEN.CHAR, 0);
  assert.equal(emptyInner.kind, 'Unknown');
  const triple = constMakeFromLiteral("'''", TOKEN.CHAR, 0);
  assert.equal(triple.kind, 'Unknown');
  const nonchar = constMakeFromLiteral("'\\uFFFE'", TOKEN.CHAR, 0);
  assert.equal(nonchar.toString(), '65534');
  const rawNl = constMakeFromLiteral("'\n'", TOKEN.CHAR, 0);
  assert.equal(rawNl.toString(), '10');
  const hanStrip = constMakeFromLiteral('中', TOKEN.CHAR, 0);
  assert.equal(hanStrip.toString(), '65533');
  const piStrip = constMakeFromLiteral('π', TOKEN.CHAR, 0);
  assert.equal(piStrip.kind, 'Unknown');
  const quotedHan = constMakeFromLiteral('"中"', TOKEN.CHAR, 0);
  assert.equal(quotedHan.toString(), '20013');
  const emojiStrip = constMakeFromLiteral('😀', TOKEN.CHAR, 0);
  assert.equal(emojiStrip.toString(), '65533');
  const dqQuote = constMakeFromLiteral('"\'"', TOKEN.CHAR, 0);
  assert.equal(dqQuote.kind, 'Unknown');
});

function evaluateImagLit(c) {
  const r = constMakeFromLiteral(c.lit, TOKEN.IMAG, 0);
  const re = constReal(r);
  const im = constImag(r);
  const [f, imF64Exact] = constFloat64Val(im);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    sign: constSign(r),
    reKind: re.kind,
    reExact: re.toString(),
    imKind: im.kind,
    imExact: im.toString(),
    imF64Bits: f64BitsHex(f),
    imF64Exact,
  };
}

test('Go 1.24 regenerates committed go/constant MakeFromLiteral IMAG fixtures; native matches every case', () => {
  const generated = go(['-constant-imag-literal']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-imag-literal-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go MakeFromLiteral IMAG fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-imag-literal');
  assert.ok(fixture.cases.length >= 40, `too few IMAG cases: ${fixture.cases.length}`);
  const unknown = fixture.cases.filter((c) => c.kind === 'Unknown');
  assert.ok(unknown.length >= 3, `need malformed IMAG cases, got ${unknown.length}`);
  const complex = fixture.cases.filter((c) => c.kind === 'Complex');
  assert.ok(complex.length >= 3, `need Complex IMAG cases, got ${complex.length}`);
  for (const c of fixture.cases) {
    const got = evaluateImagLit(c);
    assert.equal(got.kind, c.kind, `${c.id} kind lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.exact, c.exact, `${c.id} exact lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.sign, c.sign, `${c.id} sign lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.reKind, c.reKind, `${c.id} reKind lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.reExact, c.reExact, `${c.id} reExact lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.imKind, c.imKind, `${c.id} imKind lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.imExact, c.imExact, `${c.id} imExact lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.imF64Bits, c.imF64Bits, `${c.id} imF64Bits lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.imF64Exact, c.imF64Exact, `${c.id} imF64Exact lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.tokNum, TOKEN.IMAG, `${c.id} tokNum`);
  }
});

test('JS MakeFromLiteral IMAG extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    '2.5i',
    '-0.25i',
    '0x1.8p4i',
    '1e-10i',
    '08i',
    '',
    '1',
    'i',
    '1I',
  ];
  const cases = extras.map((lit, i) => evaluateImagLit({
    id: `js-imag-${i}`, tok: 'IMAG', tokNum: TOKEN.IMAG, lit,
  }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-imag-literal', cases };
  const verified = go(['-verify-constant-imag-literal'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 9 gotool constant-imag-literal cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-a-complex';
  const rejected = go(['-verify-constant-imag-literal'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-imag-literal'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-imag-literal', cases: [],
  })).status, 0);
});

test('constMakeFromLiteral IMAG: Complex (0 + xi), no-i Unknown, leftover Unknown', () => {
  const one = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
  assert.equal(one.kind, 'Complex');
  assert.equal(one.toString(), '(0 + 1i)');
  assert.equal(constReal(one).kind, 'Int');
  assert.equal(constReal(one).toString(), '0');
  assert.equal(constImag(one).kind, 'Float');
  assert.equal(constImag(one).toString(), '1');
  assert.equal(constSign(one), 1);
  const half = constMakeFromLiteral('1.5i', TOKEN.IMAG, 0);
  assert.equal(half.toString(), '(0 + 3/2i)');
  const neg = constMakeFromLiteral('-10i', TOKEN.IMAG, 0);
  assert.equal(neg.toString(), '(0 + -10i)');
  assert.equal(constSign(neg), -1);
  const empty = constMakeFromLiteral('i', TOKEN.IMAG, 0);
  assert.equal(empty.kind, 'Unknown');
  const noI = constMakeFromLiteral('1', TOKEN.IMAG, 0);
  assert.equal(noI.kind, 'Unknown');
  const leftover = constMakeFromLiteral('1ii', TOKEN.IMAG, 0);
  assert.equal(leftover.kind, 'Unknown');
});

function evaluateStrLit(c) {
  const r = constMakeFromLiteral(c.lit, TOKEN.STRING, 0);
  const [toString, toStringOk] = constToString(r);
  const utf8Valid = r.kind !== 'String' || Buffer.from(toString, 'utf8').toString('utf8') === toString;
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    toString: utf8Valid ? toString : '',
    toStringOk,
    utf8Valid: r.kind !== 'String' || utf8Valid,
    stringB64: r.kind === 'String' && utf8Valid ? Buffer.from(toString, 'utf8').toString('base64') : '',
  };
}

test('Go 1.24 regenerates committed go/constant MakeFromLiteral STRING fixtures; native matches every case', () => {
  const generated = go(['-constant-string-literal']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-string-literal-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go MakeFromLiteral STRING fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-string-literal');
  assert.ok(fixture.cases.length >= 40, `too few STRING cases: ${fixture.cases.length}`);
  const unknown = fixture.cases.filter((c) => c.kind === 'Unknown');
  assert.ok(unknown.length >= 3, `need malformed STRING cases, got ${unknown.length}`);
  const strings = fixture.cases.filter((c) => c.kind === 'String');
  assert.ok(strings.length >= 3, `need String cases, got ${strings.length}`);
  for (const c of fixture.cases) {
    const got = evaluateStrLit(c);
    assert.equal(got.kind, c.kind, `${c.id} kind lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.exact, c.exact, `${c.id} exact lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.toStringOk, c.toStringOk, `${c.id} toStringOk lit=${JSON.stringify(c.lit)}`);
    assert.equal(got.tokNum, TOKEN.STRING, `${c.id} tokNum`);
    if (c.utf8Valid) {
      assert.equal(got.toString, c.toString, `${c.id} toString lit=${JSON.stringify(c.lit)}`);
      assert.equal(got.stringB64, c.stringB64, `${c.id} stringB64 lit=${JSON.stringify(c.lit)}`);
    }
  }
});

test('JS MakeFromLiteral STRING extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    '""',
    '"foo"',
    '"hello\\n"',
    '"\\x41"',
    '"中"',
    "'a'",
    "''",
    "'ab'",
    '`raw\\n`',
    '"\\z"',
  ];
  const cases = extras.map((lit, i) => evaluateStrLit({
    id: `js-str-${i}`, tok: 'STRING', tokNum: TOKEN.STRING, lit,
  }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-string-literal', cases };
  const verified = go(['-verify-constant-string-literal'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 10 gotool constant-string-literal cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-a-string';
  const rejected = go(['-verify-constant-string-literal'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-string-literal'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-string-literal', cases: [],
  })).status, 0);
});

test('constMakeFromLiteral STRING: Unquote, raw CR strip, leftover Unknown', () => {
  const foo = constMakeFromLiteral('"foo"', TOKEN.STRING, 0);
  assert.equal(foo.kind, 'String');
  assert.equal(foo.toString(), '"foo"');
  assert.deepEqual(constToString(foo), ['foo', true]);
  const empty = constMakeFromLiteral('""', TOKEN.STRING, 0);
  assert.equal(empty.toString(), '""');
  assert.deepEqual(constToString(empty), ['', true]);
  const rune = constMakeFromLiteral("'a'", TOKEN.STRING, 0);
  assert.equal(rune.kind, 'String');
  assert.deepEqual(constToString(rune), ['a', true]);
  const extra = constMakeFromLiteral("'ab'", TOKEN.STRING, 0);
  assert.equal(extra.kind, 'Unknown');
  const emptyChar = constMakeFromLiteral("''", TOKEN.STRING, 0);
  assert.equal(emptyChar.kind, 'String');
  assert.deepEqual(constToString(emptyChar), ['', true]);
  const raw = constMakeFromLiteral('`hello\\n`', TOKEN.STRING, 0);
  assert.deepEqual(constToString(raw), ['hello\\n', true]);
  const cr = constMakeFromLiteral('`hello\rworld`', TOKEN.STRING, 0);
  assert.deepEqual(constToString(cr), ['helloworld', true]);
  const unclosed = constMakeFromLiteral('"foo', TOKEN.STRING, 0);
  assert.equal(unclosed.kind, 'Unknown');
  const hex = constMakeFromLiteral('"\\xff"', TOKEN.STRING, 0);
  assert.equal(hex.kind, 'String');
  assert.equal(hex.toString(), '"\\xff"');
});

test('constMakeInt64 rejects non-bigint and values outside int64', () => {
  assert.throws(() => constMakeInt64(1), TypeError);
  assert.throws(() => constMakeInt64(null), TypeError);
  assert.throws(() => constMakeInt64('1'), TypeError);
  assert.throws(() => constBitLen({ kind: 'Int' }), TypeError);
  assert.throws(() => constMakeInt64((1n << 63n)), /int64/);
  assert.throws(() => constMakeInt64(-(1n << 63n) - 1n), /int64/);
  const min = constMakeInt64(-(1n << 63n));
  assert.ok(min instanceof GoConstValue);
  assert.equal(min.kind, 'Int');
  assert.equal(constToInt(min)[0], -(1n << 63n));
});

const BOOL_OP_TOK = { MAKE: 0, NOT: TOKEN.NOT, LAND: TOKEN.LAND, LOR: TOKEN.LOR, EQL: TOKEN.EQL, NEQ: TOKEN.NEQ };

function boolSrc(name) {
  if (name === 'true') return constMakeBool(true);
  if (name === 'false') return constMakeBool(false);
  if (name === 'unknown') return constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(0n));
  throw new Error(`unknown bool src ${name}`);
}

function evaluateBool(c) {
  const x = boolSrc(c.x);
  let r;
  if (c.form === 'make') r = x;
  else if (c.form === 'not') r = constUnaryOp(TOKEN.NOT, x, 0);
  else if (c.form === 'land') r = constBinaryOp(TOKEN.LAND, x, boolSrc(c.y));
  else if (c.form === 'lor') r = constBinaryOp(TOKEN.LOR, x, boolSrc(c.y));
  else if (c.form === 'eql' || c.form === 'neq') {
    r = constCompareOp(x, TOKEN[c.op], boolSrc(c.y));
  } else throw new Error(`unknown form ${c.form}`);
  const [boolVal, boolValOk] = constBoolVal(r);
  return { ...c, kind: r.kind, exact: r.toString(), boolVal, boolValOk };
}

test('Go 1.24 regenerates committed go/constant Bool fixtures; native matches every case', () => {
  const generated = go(['-constant-bool']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-bool-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go Bool fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-bool');
  assert.ok(fixture.cases.length >= 42, `too few Bool cases: ${fixture.cases.length}`);
  const unknown = fixture.cases.filter((c) => c.kind === 'Unknown');
  assert.ok(unknown.length >= 3, `need Unknown Bool cases, got ${unknown.length}`);
  for (const c of fixture.cases) {
    const got = evaluateBool(c);
    assert.equal(got.opTok, BOOL_OP_TOK[c.op], `${c.id} opTok`);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.boolVal, c.boolVal, `${c.id} boolVal`);
    assert.equal(got.boolValOk, c.boolValOk, `${c.id} boolValOk`);
  }
});

test('JS Bool extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    ['make', 'true', 'false'],
    ['make', 'false', 'false'],
    ['not', 'true', 'false'],
    ['not', 'unknown', 'false'],
    ['land', 'true', 'false'],
    ['lor', 'false', 'false'],
    ['eql', 'true', 'true'],
    ['neq', 'true', 'false'],
    ['eql', 'false', 'false'],
    ['neq', 'false', 'true'],
    ['eql', 'unknown', 'false'],
    ['neq', 'unknown', 'true'],
    ['eql', 'unknown', 'unknown'],
    ['neq', 'unknown', 'unknown'],
    ['land', 'unknown', 'true'],
    ['lor', 'unknown', 'unknown'],
  ];
  const cases = extras.map(([form, x, y], i) => {
    const r = evaluateBool({ form, x, y, op: form.toUpperCase() === 'MAKE' ? 'MAKE' : form.toUpperCase() });
    return {
      id: `js-bool-${i}`, form, x, y, op: r.op ?? (form === 'make' ? 'MAKE' : form.toUpperCase()),
      opTok: BOOL_OP_TOK[form === 'make' ? 'MAKE' : form.toUpperCase()],
      kind: r.kind, exact: r.exact, boolVal: r.boolVal, boolValOk: r.boolValOk,
    };
  });
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-bool', cases };
  const verified = go(['-verify-constant-bool'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 16 gotool constant-bool cases/);
  const broken = structuredClone(packet);
  broken.cases[1].exact = 'not-a-bool';
  const rejected = go(['-verify-constant-bool'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify-constant-bool'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-bool', cases: [],
  })).status, 0);
});

test('constMakeBool / BoolVal / NOT / LAND / LOR vs Go; malformed throw', () => {
  const t = constMakeBool(true);
  const f = constMakeBool(false);
  const unk = constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(0n));
  const one = constMakeInt64(1n);
  assert.equal(t.kind, 'Bool');
  assert.equal(t.toString(), 'true');
  assert.deepEqual(constBoolVal(t), [true, true]);
  assert.deepEqual(constBoolVal(f), [false, true]);
  assert.deepEqual(constBoolVal(unk), [false, true]);
  assert.deepEqual(constBoolVal(one), [false, false]);
  assert.deepEqual(constToString(t), ['', false]);
  assert.equal(constUnaryOp(TOKEN.NOT, t, 0).toString(), 'false');
  assert.equal(constUnaryOp(TOKEN.NOT, f, 0).toString(), 'true');
  assert.equal(constUnaryOp(TOKEN.NOT, unk, 0).kind, 'Unknown');
  assert.equal(constBinaryOp(TOKEN.LAND, t, f).toString(), 'false');
  assert.equal(constBinaryOp(TOKEN.LOR, t, f).toString(), 'true');
  assert.equal(constBinaryOp(TOKEN.LAND, t, unk).kind, 'Unknown');
  assert.throws(() => constMakeBool('true'), TypeError);
  assert.throws(() => constMakeBool(1), TypeError);
  assert.throws(() => constUnaryOp(TOKEN.NOT, one, 0), /NOT requires Bool/);
  assert.throws(() => constBinaryOp(TOKEN.LAND, one, t), /LAND\/LOR require Bool/);
  assert.throws(() => constBinaryOp(TOKEN.ADD, t, f), /LAND or LOR/);
  assert.throws(() => constBinaryOp(TOKEN.AND, t, t), /LAND or LOR/);
  assert.throws(() => constSign(t), /numeric or Unknown/);
  assert.throws(() => constCompare(t, f), /Int or Float/);
});

function makeCplx(form, x, y) {
  if (form === 'imag') return constMakeFromLiteral(x, TOKEN.IMAG, 0);
  if (form === 'int') return constMakeInt64(BigInt(x));
  if (form === 'quo') return constBinaryOp(TOKEN.QUO, constMakeInt64(BigInt(x)), constMakeInt64(BigInt(y)));
  if (form === 'unknown') return constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(0n));
  throw new Error(`unknown complex src ${form}`);
}

function evaluateCBin(c) {
  const r = constBinaryOp(TOKEN[c.op], makeCplx(c.formX, c.xx, c.xy), makeCplx(c.formY, c.yx, c.yy));
  const re = constReal(r);
  const im = constImag(r);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    sign: constSign(r),
    reKind: re.kind,
    reExact: re.toString(),
    imKind: im.kind,
    imExact: im.toString(),
  };
}

test('Go 1.24 regenerates committed go/constant Complex BinaryOp fixtures; native matches every case', () => {
  const generated = go(['-constant-complex-binop']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-complex-binop-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go Complex BinaryOp fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-complex-binop');
  assert.ok(fixture.cases.length >= 180, `too few Complex BinaryOp cases: ${fixture.cases.length}`);
  const unknown = fixture.cases.filter((c) => c.kind === 'Unknown');
  assert.ok(unknown.length >= 3, `need Unknown Complex BinaryOp cases, got ${unknown.length}`);
  const complex = fixture.cases.filter((c) => c.kind === 'Complex');
  assert.ok(complex.length >= 3, `need Complex BinaryOp cases, got ${complex.length}`);
  for (const c of fixture.cases) {
    const got = evaluateCBin(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.reKind, c.reKind, `${c.id} reKind`);
    assert.equal(got.reExact, c.reExact, `${c.id} reExact`);
    assert.equal(got.imKind, c.imKind, `${c.id} imKind`);
    assert.equal(got.imExact, c.imExact, `${c.id} imExact`);
    assert.equal(got.opTok, TOKEN[c.op], `${c.id} opTok`);
  }
});

test('JS Complex BinaryOp extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { formX: 'imag', xx: '4i', xy: '0', formY: 'imag', yx: '2i', yy: '0', op: 'ADD' },
    { formX: 'imag', xx: '4i', xy: '0', formY: 'imag', yx: '2i', yy: '0', op: 'MUL' },
    { formX: 'int', xx: '7', xy: '0', formY: 'imag', yx: '1i', yy: '0', op: 'ADD' },
    { formX: 'quo', xx: '1', xy: '4', formY: 'imag', yx: '1i', yy: '0', op: 'SUB' },
    { formX: 'imag', xx: '2i', xy: '0', formY: 'unknown', yx: '0', yy: '0', op: 'MUL' },
    { formX: 'imag', xx: '8i', xy: '0', formY: 'imag', yx: '2i', yy: '0', op: 'QUO' },
  ];
  const cases = extras.map((c, i) => evaluateCBin({
    id: `js-cbin-${i}`, opTok: TOKEN[c.op], ...c,
  }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-complex-binop', cases };
  const verified = go(['-verify-constant-complex-binop'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 6 gotool constant-complex-binop cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-a-complex';
  const rejected = go(['-verify-constant-complex-binop'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-complex-binop'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-complex-binop', cases: [],
  })).status, 0);
});

test('constBinaryOp Complex: 1i*1i, mixed Int, QUO-0 Unknown, REM/AND throw', () => {
  const i = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
  const twoI = constMakeFromLiteral('2i', TOKEN.IMAG, 0);
  const one = constMakeInt64(1n);
  const z = constMakeInt64(0n);
  const prod = constBinaryOp(TOKEN.MUL, i, i);
  assert.equal(prod.kind, 'Complex');
  assert.equal(prod.toString(), '(-1 + 0i)');
  assert.equal(constReal(prod).kind, 'Float');
  assert.equal(constReal(prod).toString(), '-1');
  assert.equal(constImag(prod).kind, 'Float');
  assert.equal(constImag(prod).toString(), '0');
  assert.equal(constSign(prod), -1);
  const sum = constBinaryOp(TOKEN.ADD, one, i);
  assert.equal(sum.toString(), '(1 + 1i)');
  assert.equal(constReal(sum).kind, 'Int');
  assert.equal(constImag(sum).kind, 'Float');
  const quo = constBinaryOp(TOKEN.QUO, constMakeFromLiteral('5i', TOKEN.IMAG, 0), constMakeFromLiteral('3i', TOKEN.IMAG, 0));
  assert.equal(quo.toString(), '(5/3 + 0i)');
  const unk = constBinaryOp(TOKEN.QUO, i, z);
  assert.equal(unk.kind, 'Unknown');
  const zeroI = constMakeFromLiteral('0i', TOKEN.IMAG, 0);
  assert.equal(constBinaryOp(TOKEN.QUO, i, zeroI).kind, 'Unknown');
  assert.equal(constBinaryOp(TOKEN.ADD, i, unk).kind, 'Unknown');
  assert.throws(() => constBinaryOp(TOKEN.REM, i, twoI), /ADD, SUB, MUL, or QUO/);
  assert.throws(() => constBinaryOp(TOKEN.AND, i, one), /ADD, SUB, MUL, or QUO/);
  assert.throws(() => constBinaryOp(TOKEN.XOR, i, i), /ADD, SUB, MUL, or QUO/);
});

function makeCplxUn(form, x, y) {
  if (form === 'imag') return constMakeFromLiteral(x, TOKEN.IMAG, 0);
  if (form === 'unknown') return constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(0n));
  if (form === 'sum') return constBinaryOp(TOKEN.ADD, constMakeInt64(BigInt(x)), constMakeFromLiteral(y, TOKEN.IMAG, 0));
  throw new Error(`unknown complex unary src ${form}`);
}

function evaluateCUn(c) {
  const r = constUnaryOp(TOKEN[c.op], makeCplxUn(c.formY, c.yx, c.yy), 0);
  const re = constReal(r);
  const im = constImag(r);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    sign: constSign(r),
    reKind: re.kind,
    reExact: re.toString(),
    imKind: im.kind,
    imExact: im.toString(),
  };
}

test('Go 1.24 regenerates committed go/constant Complex UnaryOp fixtures; native matches every case', () => {
  const generated = go(['-constant-complex-unary']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-complex-unary-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go Complex UnaryOp fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-complex-unary');
  assert.ok(fixture.cases.length >= 36, `too few Complex UnaryOp cases: ${fixture.cases.length}`);
  const unknown = fixture.cases.filter((c) => c.kind === 'Unknown');
  assert.ok(unknown.length >= 3, `need Unknown Complex UnaryOp cases, got ${unknown.length}`);
  const complex = fixture.cases.filter((c) => c.kind === 'Complex');
  assert.ok(complex.length >= 3, `need Complex UnaryOp cases, got ${complex.length}`);
  const malformed = fixture.cases.filter((c) => c.formY === 'imag' && ['1ii', 'i', 'xyz'].includes(c.yx));
  assert.ok(malformed.length >= 6, `need malformed IMAG unary cases, got ${malformed.length}`);
  for (const c of fixture.cases) {
    const got = evaluateCUn(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.reKind, c.reKind, `${c.id} reKind`);
    assert.equal(got.reExact, c.reExact, `${c.id} reExact`);
    assert.equal(got.imKind, c.imKind, `${c.id} imKind`);
    assert.equal(got.imExact, c.imExact, `${c.id} imExact`);
    assert.equal(got.opTok, TOKEN[c.op], `${c.id} opTok`);
  }
});

test('JS Complex UnaryOp extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { formY: 'imag', yx: '4i', yy: '0', op: 'ADD' },
    { formY: 'imag', yx: '4i', yy: '0', op: 'SUB' },
    { formY: 'sum', yx: '7', yy: '1i', op: 'SUB' },
    { formY: 'imag', yx: '1ii', yy: '0', op: 'ADD' },
    { formY: 'imag', yx: 'i', yy: '0', op: 'SUB' },
    { formY: 'unknown', yx: '0', yy: '0', op: 'SUB' },
  ];
  const cases = extras.map((c, i) => evaluateCUn({
    id: `js-cun-${i}`, opTok: TOKEN[c.op], ...c,
  }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-complex-unary', cases };
  const verified = go(['-verify-constant-complex-unary'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 6 gotool constant-complex-unary cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-a-complex';
  const rejected = go(['-verify-constant-complex-unary'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-complex-unary'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-complex-unary', cases: [],
  })).status, 0);
});

test('constUnaryOp Complex: +1i identity, -1i, mixed 1+1i, Unknown, XOR/NOT throw', () => {
  const i = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
  const pos = constUnaryOp(TOKEN.ADD, i, 0);
  assert.equal(pos.kind, 'Complex');
  assert.equal(pos.toString(), '(0 + 1i)');
  assert.equal(constReal(pos).kind, 'Int');
  assert.equal(constImag(pos).kind, 'Float');
  const neg = constUnaryOp(TOKEN.SUB, i, 0);
  assert.equal(neg.toString(), '(0 + -1i)');
  assert.equal(constSign(neg), -1);
  assert.equal(constUnaryOp(TOKEN.SUB, neg, 0).toString(), '(0 + 1i)');
  const mixed = constBinaryOp(TOKEN.ADD, constMakeInt64(1n), i);
  assert.equal(constUnaryOp(TOKEN.SUB, mixed, 0).toString(), '(-1 + -1i)');
  const zeroI = constMakeFromLiteral('0i', TOKEN.IMAG, 0);
  assert.equal(constUnaryOp(TOKEN.SUB, zeroI, 0).toString(), '(0 + 0i)');
  assert.equal(constSign(constUnaryOp(TOKEN.SUB, zeroI, 0)), 0);
  const unk = constMakeFromLiteral('1ii', TOKEN.IMAG, 0);
  assert.equal(unk.kind, 'Unknown');
  assert.equal(constUnaryOp(TOKEN.ADD, unk, 0).kind, 'Unknown');
  assert.equal(constUnaryOp(TOKEN.SUB, unk, 0).kind, 'Unknown');
  assert.throws(() => constUnaryOp(TOKEN.XOR, i, 0), /Int/);
  assert.throws(() => constUnaryOp(TOKEN.XOR, i, 8), /Int/);
  assert.throws(() => constUnaryOp(TOKEN.NOT, i, 0), /NOT requires Bool/);
});

function makeCplxCmp(form, x, y) {
  if (form === 'imag' || form === 'int' || form === 'quo' || form === 'unknown') {
    return makeCplx(form, x, y);
  }
  if (form === 'sum') return makeCplxUn(form, x, y);
  throw new Error(`unknown complex compare src ${form}`);
}

function evaluateCCmp(c) {
  const r = constCompareOp(
    makeCplxCmp(c.formX, c.xx, c.xy),
    TOKEN[c.op],
    makeCplxCmp(c.formY, c.yx, c.yy),
  );
  const [boolVal, boolValOk] = constBoolVal(r);
  return {
    ...c,
    kind: r.kind,
    exact: r.toString(),
    boolVal,
    boolValOk,
  };
}

test('Go 1.24 regenerates committed go/constant Complex Compare fixtures; native matches every case', () => {
  const generated = go(['-constant-complex-compare']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-complex-compare-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go Complex Compare fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-complex-compare');
  assert.ok(fixture.cases.length >= 450, `too few Complex Compare cases: ${fixture.cases.length}`);
  const unknown = fixture.cases.filter((c) => c.formX === 'unknown' || c.formY === 'unknown' || (c.formX === 'imag' && ['1ii', 'i', 'xyz'].includes(c.xx)) || (c.formY === 'imag' && ['1ii', 'i', 'xyz'].includes(c.yx)));
  assert.ok(unknown.length >= 3, `need Unknown/malformed Complex Compare cases, got ${unknown.length}`);
  const eql = fixture.cases.filter((c) => c.op === 'EQL');
  const neq = fixture.cases.filter((c) => c.op === 'NEQ');
  assert.ok(eql.length >= 3, `need EQL cases, got ${eql.length}`);
  assert.ok(neq.length >= 3, `need NEQ cases, got ${neq.length}`);
  const malformed = fixture.cases.filter((c) => (c.formX === 'imag' && ['1ii', 'i', 'xyz'].includes(c.xx)) || (c.formY === 'imag' && ['1ii', 'i', 'xyz'].includes(c.yx)));
  assert.ok(malformed.length >= 3, `need malformed IMAG compare cases, got ${malformed.length}`);
  for (const c of fixture.cases) {
    const got = evaluateCCmp(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.boolVal, c.boolVal, `${c.id} boolVal`);
    assert.equal(got.boolValOk, c.boolValOk, `${c.id} boolValOk`);
    assert.equal(got.opTok, TOKEN[c.op], `${c.id} opTok`);
  }
});

test('JS Complex Compare extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { formX: 'imag', xx: '4i', xy: '0', formY: 'imag', yx: '4i', yy: '0', op: 'EQL' },
    { formX: 'imag', xx: '4i', xy: '0', formY: 'imag', yx: '2i', yy: '0', op: 'NEQ' },
    { formX: 'int', xx: '0', xy: '0', formY: 'imag', yx: '0i', yy: '0', op: 'EQL' },
    { formX: 'sum', xx: '1', xy: '1i', formY: 'imag', yx: '1i', yy: '0', op: 'NEQ' },
    { formX: 'imag', xx: '1ii', xy: '0', formY: 'imag', yx: '1i', yy: '0', op: 'EQL' },
    { formX: 'imag', xx: 'xyz', xy: '0', formY: 'unknown', yx: '0', yy: '0', op: 'NEQ' },
  ];
  const cases = extras.map((c, i) => evaluateCCmp({
    id: `js-ccmp-${i}`, opTok: TOKEN[c.op], ...c,
  }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-complex-compare', cases };
  const verified = go(['-verify-constant-complex-compare'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 6 gotool constant-complex-compare cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-a-bool';
  const rejected = go(['-verify-constant-complex-compare'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-complex-compare'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-complex-compare', cases: [],
  })).status, 0);
});

test('constCompareOp Complex EQL/NEQ vs Go; LSS/Bool/mixed String throw; constCompare stays numeric', () => {
  const i = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
  const twoI = constMakeFromLiteral('2i', TOKEN.IMAG, 0);
  const zeroI = constMakeFromLiteral('0i', TOKEN.IMAG, 0);
  const one = constMakeInt64(1n);
  const z = constMakeInt64(0n);
  const unk = constMakeFromLiteral('1ii', TOKEN.IMAG, 0);
  assert.equal(unk.kind, 'Unknown');
  assert.equal(constCompareOp(i, TOKEN.EQL, i).toString(), 'true');
  assert.equal(constCompareOp(i, TOKEN.NEQ, i).toString(), 'false');
  assert.equal(constCompareOp(i, TOKEN.EQL, twoI).toString(), 'false');
  assert.equal(constCompareOp(i, TOKEN.NEQ, twoI).toString(), 'true');
  assert.equal(constCompareOp(z, TOKEN.EQL, zeroI).toString(), 'true');
  assert.equal(constCompareOp(one, TOKEN.EQL, i).toString(), 'false');
  const mixed = constBinaryOp(TOKEN.ADD, one, i);
  assert.equal(constCompareOp(mixed, TOKEN.EQL, i).toString(), 'false');
  assert.equal(constCompareOp(mixed, TOKEN.EQL, mixed).toString(), 'true');
  assert.equal(constCompareOp(unk, TOKEN.EQL, i).toString(), 'false');
  assert.equal(constCompareOp(unk, TOKEN.NEQ, i).toString(), 'true');
  assert.equal(constCompareOp(unk, TOKEN.NEQ, unk).toString(), 'false');
  const t = constMakeBool(true);
  const s = constMakeFromLiteral('"a"', TOKEN.STRING, 0);
  assert.throws(() => constCompareOp(i, TOKEN.LSS, twoI), /EQL or NEQ/);
  assert.throws(() => constCompareOp(i, TOKEN.ADD, twoI), /EQL or NEQ/);
  assert.throws(() => constCompareOp(t, TOKEN.EQL, i), /mixed Bool/);
  assert.throws(() => constCompareOp(s, TOKEN.EQL, i), /mixed String/);
  assert.throws(() => constCompare(i, twoI), /Int or Float/);
});

function evaluateSCmp(c) {
  const x = constMakeFromLiteral(c.litX, TOKEN.STRING, 0);
  const y = constMakeFromLiteral(c.litY, TOKEN.STRING, 0);
  const r = constCompareOp(x, TOKEN[c.op], y);
  const [boolVal, boolValOk] = constBoolVal(r);
  return {
    ...c,
    kindX: x.kind,
    kindY: y.kind,
    kind: r.kind,
    exact: r.toString(),
    boolVal,
    boolValOk,
  };
}

test('Go 1.24 regenerates committed go/constant String Compare fixtures; native matches every case', () => {
  const generated = go(['-constant-string-compare']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-string-compare-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go String Compare fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-string-compare');
  assert.ok(fixture.cases.length >= 1014, `too few String Compare cases: ${fixture.cases.length}`);
  const unknown = fixture.cases.filter((c) => c.kindX === 'Unknown' || c.kindY === 'Unknown');
  assert.ok(unknown.length >= 3, `need Unknown String Compare cases, got ${unknown.length}`);
  const malformed = fixture.cases.filter((c) => ['"\\z"', "'ab'", '"'].includes(c.litX) || ['"\\z"', "'ab'", '"'].includes(c.litY));
  assert.ok(malformed.length >= 3, `need malformed STRING compare cases, got ${malformed.length}`);
  const order = fixture.cases.filter((c) => ['LSS', 'LEQ', 'GTR', 'GEQ'].includes(c.op));
  assert.ok(order.length >= 3, `need order ops, got ${order.length}`);
  for (const c of fixture.cases) {
    const got = evaluateSCmp(c);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.boolVal, c.boolVal, `${c.id} boolVal`);
    assert.equal(got.boolValOk, c.boolValOk, `${c.id} boolValOk`);
    assert.equal(got.opTok, TOKEN[c.op], `${c.id} opTok`);
    assert.equal(constMakeFromLiteral(c.litX, TOKEN.STRING, 0).kind, c.kindX, `${c.id} kindX`);
    assert.equal(constMakeFromLiteral(c.litY, TOKEN.STRING, 0).kind, c.kindY, `${c.id} kindY`);
  }
});

test('JS String Compare extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { litX: '"z"', litY: '"a"', op: 'GTR' },
    { litX: '""', litY: '"\\x01"', op: 'LSS' },
    { litX: '"\\x80"', litY: '"\\xff"', op: 'LSS' },
    { litX: '"π"', litY: '"中"', op: 'LSS' },
    { litX: '"\\z"', litY: '"a"', op: 'NEQ' },
    { litX: "'ab'", litY: '"a"', op: 'EQL' },
  ];
  const cases = extras.map((c, i) => evaluateSCmp({
    id: `js-scmp-${i}`, opTok: TOKEN[c.op], ...c,
  }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-string-compare', cases };
  const verified = go(['-verify-constant-string-compare'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 6 gotool constant-string-compare cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-a-bool';
  const rejected = go(['-verify-constant-string-compare'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-string-compare'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-string-compare', cases: [],
  })).status, 0);
});

test('constCompareOp Bool EQL/NEQ vs Go; mixed/LSS throw; Unknown LSS is false; constCompare stays numeric', () => {
  const t = constMakeBool(true);
  const f = constMakeBool(false);
  const unk = constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(0n));
  const one = constMakeInt64(1n);
  const i = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
  const s = constMakeFromLiteral('"a"', TOKEN.STRING, 0);
  const ch = constMakeFromLiteral("'a'", TOKEN.CHAR, 0);
  assert.equal(unk.kind, 'Unknown');
  assert.equal(constCompareOp(t, TOKEN.EQL, t).toString(), 'true');
  assert.equal(constCompareOp(t, TOKEN.EQL, f).toString(), 'false');
  assert.equal(constCompareOp(t, TOKEN.NEQ, f).toString(), 'true');
  assert.equal(constCompareOp(t, TOKEN.NEQ, t).toString(), 'false');
  assert.equal(constCompareOp(f, TOKEN.EQL, f).toString(), 'true');
  assert.equal(constCompareOp(t, TOKEN.EQL, unk).toString(), 'false');
  assert.equal(constCompareOp(unk, TOKEN.NEQ, t).toString(), 'false');
  assert.equal(constCompareOp(unk, TOKEN.EQL, unk).toString(), 'false');
  assert.equal(constCompareOp(unk, TOKEN.NEQ, unk).toString(), 'false');
  // Go unknownVal short-circuits every op, including LSS, to false.
  assert.equal(constCompareOp(unk, TOKEN.LSS, t).toString(), 'false');
  assert.equal(constCompareOp(t, TOKEN.LSS, unk).toString(), 'false');
  assert.throws(() => constCompareOp(t, TOKEN.LSS, f), /EQL or NEQ/);
  assert.throws(() => constCompareOp(t, TOKEN.ADD, f), /EQL or NEQ/);
  assert.throws(() => constCompareOp(t, TOKEN.EQL, one), /mixed Bool/);
  assert.throws(() => constCompareOp(t, TOKEN.EQL, i), /mixed Bool/);
  assert.throws(() => constCompareOp(t, TOKEN.EQL, ch), /mixed Bool/);
  assert.throws(() => constCompareOp(one, TOKEN.EQL, t), /mixed Bool/);
  assert.throws(() => constCompareOp(s, TOKEN.EQL, t), /mixed String/);
  assert.throws(() => constCompare(t, f), /Int or Float/);
});

test('constCompareOp String EQL/NEQ/order vs Go; mixed/ADD throw; constCompare stays numeric', () => {
  const a = constMakeFromLiteral('"a"', TOKEN.STRING, 0);
  const b = constMakeFromLiteral('"b"', TOKEN.STRING, 0);
  const aa = constMakeFromLiteral('"aa"', TOKEN.STRING, 0);
  const empty = constMakeFromLiteral('""', TOKEN.STRING, 0);
  const ff = constMakeFromLiteral('"\\xff"', TOKEN.STRING, 0);
  const unk = constMakeFromLiteral('"\\z"', TOKEN.STRING, 0);
  const leftover = constMakeFromLiteral("'ab'", TOKEN.STRING, 0);
  const one = constMakeInt64(1n);
  const i = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
  const t = constMakeBool(true);
  assert.equal(unk.kind, 'Unknown');
  assert.equal(leftover.kind, 'Unknown');
  assert.equal(constCompareOp(a, TOKEN.EQL, a).toString(), 'true');
  assert.equal(constCompareOp(a, TOKEN.NEQ, a).toString(), 'false');
  assert.equal(constCompareOp(a, TOKEN.LSS, b).toString(), 'true');
  assert.equal(constCompareOp(a, TOKEN.LEQ, a).toString(), 'true');
  assert.equal(constCompareOp(b, TOKEN.GTR, a).toString(), 'true');
  assert.equal(constCompareOp(a, TOKEN.GEQ, a).toString(), 'true');
  assert.equal(constCompareOp(empty, TOKEN.LSS, a).toString(), 'true');
  assert.equal(constCompareOp(a, TOKEN.LSS, aa).toString(), 'true');
  assert.equal(constCompareOp(a, TOKEN.LSS, ff).toString(), 'true');
  assert.equal(constCompareOp(unk, TOKEN.EQL, a).toString(), 'false');
  assert.equal(constCompareOp(unk, TOKEN.NEQ, a).toString(), 'false');
  assert.equal(constCompareOp(unk, TOKEN.LSS, a).toString(), 'false');
  assert.equal(constCompareOp(leftover, TOKEN.EQL, a).toString(), 'false');
  assert.equal(constCompareOp(unk, TOKEN.LSS, leftover).toString(), 'false');
  assert.equal(constCompareOp(unk, TOKEN.NEQ, unk).toString(), 'false');
  assert.throws(() => constCompareOp(a, TOKEN.ADD, b), /String op/);
  assert.throws(() => constCompareOp(a, TOKEN.EQL, one), /mixed String/);
  assert.throws(() => constCompareOp(a, TOKEN.EQL, i), /mixed String/);
  assert.throws(() => constCompareOp(a, TOKEN.EQL, t), /mixed String/);
  assert.throws(() => constCompare(a, b), /Int or Float/);
});

function makeConvSrc(c) {
  switch (c.form) {
    case 'int':
      return constMakeInt64(BigInt(c.x));
    case 'quo':
      return constBinaryOp(TOKEN.QUO, constMakeInt64(BigInt(c.x)), constMakeInt64(BigInt(c.y)));
    case 'shift':
      return constShift(TOKEN.SHL, constMakeInt64(BigInt(c.x)), BigInt(c.s));
    case 'imag':
      return constMakeFromLiteral(c.x, TOKEN.IMAG, 0);
    case 'sum':
      return constBinaryOp(TOKEN.ADD, constMakeInt64(BigInt(c.x)), constMakeFromLiteral(c.y, TOKEN.IMAG, 0));
    case 'bool':
      return constMakeBool(c.x === 'true');
    case 'string':
      return constMakeFromLiteral(c.x, TOKEN.STRING, 0);
    case 'char':
      return constMakeFromLiteral(c.x, TOKEN.CHAR, 0);
    case 'unknown':
      return constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(0n));
    default:
      throw new Error(`unknown convert form ${c.form}`);
  }
}

function convertValue(src, convert) {
  switch (convert) {
    case 'ToFloat':
      return constToFloat(src);
    case 'ToComplex':
      return constToComplex(src);
    case 'ToInt':
      return constToIntValue(src);
    default:
      throw new Error(`unknown convert ${convert}`);
  }
}

function evaluateConv(c) {
  const src = makeConvSrc(c);
  const r = convertValue(src, c.convert);
  const re = constReal(r);
  const im = constImag(r);
  const [f] = constFloat64Val(r);
  return {
    ...c,
    origKind: src.kind,
    kind: r.kind,
    exact: r.toString(),
    sign: constSign(r),
    reKind: re.kind,
    reExact: re.toString(),
    imKind: im.kind,
    imExact: im.toString(),
    f64Bits: r.kind === 'Complex' ? '0' : f64BitsHex(f),
    f64Exact: r.kind === 'Complex' ? false : constFloat64Val(r)[1],
  };
}

test('Go 1.24 regenerates committed go/constant ToFloat/ToComplex fixtures; native matches every case', () => {
  const generated = go(['-constant-tofloat-tocomplex']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-tofloat-tocomplex-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go ToFloat/ToComplex fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-tofloat-tocomplex');
  assert.ok(fixture.cases.length >= 68, `too few convert cases: ${fixture.cases.length}`);
  const toFloat = fixture.cases.filter((c) => c.convert === 'ToFloat');
  const toComplex = fixture.cases.filter((c) => c.convert === 'ToComplex');
  assert.ok(toFloat.length >= 34, `need ToFloat cases, got ${toFloat.length}`);
  assert.ok(toComplex.length >= 34, `need ToComplex cases, got ${toComplex.length}`);
  const malformed = fixture.cases.filter((c) => ['1ii', 'i', 'xyz', `"\\z"`, `'ab'`, `''`].includes(c.x) || c.form === 'unknown');
  assert.ok(malformed.length >= 6, `need malformed convert cases, got ${malformed.length}`);
  const unknownOut = fixture.cases.filter((c) => c.kind === 'Unknown');
  assert.ok(unknownOut.length >= 3, `need Unknown results, got ${unknownOut.length}`);
  for (const c of fixture.cases) {
    const got = evaluateConv(c);
    assert.equal(got.origKind, c.origKind, `${c.id} origKind`);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.reKind, c.reKind, `${c.id} reKind`);
    assert.equal(got.reExact, c.reExact, `${c.id} reExact`);
    assert.equal(got.imKind, c.imKind, `${c.id} imKind`);
    assert.equal(got.imExact, c.imExact, `${c.id} imExact`);
    assert.equal(got.f64Bits, c.f64Bits, `${c.id} f64Bits`);
    assert.equal(got.f64Exact, c.f64Exact, `${c.id} f64Exact`);
  }
});

test('JS ToFloat/ToComplex extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { convert: 'ToFloat', form: 'int', x: '3', y: '0', s: '0' },
    { convert: 'ToComplex', form: 'quo', x: '3', y: '2', s: '0' },
    { convert: 'ToFloat', form: 'imag', x: '2i', y: '0', s: '0' },
    { convert: 'ToFloat', form: 'imag', x: '0i', y: '0', s: '0' },
    { convert: 'ToComplex', form: 'char', x: `'π'`, y: '0', s: '0' },
    { convert: 'ToFloat', form: 'string', x: '"', y: '0', s: '0' },
    { convert: 'ToComplex', form: 'bool', x: 'true', y: '0', s: '0' },
    { convert: 'ToFloat', form: 'sum', x: '-1', y: '1i', s: '0' },
  ];
  const cases = extras.map((c, i) => evaluateConv({ id: `js-conv-${i}`, ...c }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-tofloat-tocomplex', cases };
  const verified = go(['-verify-constant-tofloat-tocomplex'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 8 gotool constant-tofloat-tocomplex cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-a-float';
  const rejected = go(['-verify-constant-tofloat-tocomplex'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-tofloat-tocomplex'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-tofloat-tocomplex', cases: [],
  })).status, 0);
});

test('constToFloat/constToComplex vs Go: Int→Float, 0i unwraps, 1i stays Unknown, Bool/String Unknown', () => {
  const one = constMakeInt64(1n);
  const half = constBinaryOp(TOKEN.QUO, one, constMakeInt64(2n));
  const i = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
  const zeroI = constMakeFromLiteral('0i', TOKEN.IMAG, 0);
  const t = constMakeBool(true);
  const s = constMakeFromLiteral('"a"', TOKEN.STRING, 0);
  const ch = constMakeFromLiteral("'a'", TOKEN.CHAR, 0);
  const leftover = constMakeFromLiteral("'ab'", TOKEN.CHAR, 0);
  const unk = constMakeFromLiteral('1ii', TOKEN.IMAG, 0);
  const emptyChar = constMakeFromLiteral("''", TOKEN.CHAR, 0);
  assert.equal(constToFloat(one).kind, 'Float');
  assert.equal(constToFloat(one).toString(), '1');
  assert.equal(constToComplex(one).toString(), '(1 + 0i)');
  assert.equal(constImag(constToComplex(one)).kind, 'Int');
  assert.equal(constToFloat(half).toString(), '1/2');
  assert.equal(constToComplex(half).toString(), '(1/2 + 0i)');
  assert.equal(constToFloat(i).kind, 'Unknown');
  assert.equal(constToComplex(i).toString(), '(0 + 1i)');
  assert.equal(constToFloat(zeroI).kind, 'Float');
  assert.equal(constToFloat(zeroI).toString(), '0');
  assert.equal(constToComplex(zeroI).toString(), '(0 + 0i)');
  assert.equal(constToFloat(t).kind, 'Unknown');
  assert.equal(constToComplex(t).kind, 'Unknown');
  assert.equal(constToFloat(s).kind, 'Unknown');
  assert.equal(constToComplex(s).kind, 'Unknown');
  assert.equal(constToFloat(ch).toString(), '97');
  assert.equal(constToComplex(ch).toString(), '(97 + 0i)');
  assert.equal(leftover.kind, 'Int');
  assert.equal(constToFloat(leftover).toString(), '97');
  assert.equal(unk.kind, 'Unknown');
  assert.equal(constToFloat(unk).kind, 'Unknown');
  assert.equal(constToComplex(unk).kind, 'Unknown');
  assert.equal(emptyChar.kind, 'Unknown');
  assert.equal(constToFloat(emptyChar).kind, 'Unknown');
  assert.throws(() => constToFloat(1), TypeError);
  assert.throws(() => constToComplex(1), TypeError);
});

test('Go 1.24 regenerates committed go/constant ToInt fixtures; native matches every case', () => {
  const generated = go(['-constant-toint']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./constant-toint-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go ToInt fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.equal(fixture.slice, 'constant-toint');
  assert.ok(fixture.cases.length >= 44, `too few ToInt cases: ${fixture.cases.length}`);
  const ints = fixture.cases.filter((c) => c.kind === 'Int');
  const unknownOut = fixture.cases.filter((c) => c.kind === 'Unknown');
  assert.ok(ints.length >= 3, `need Int results, got ${ints.length}`);
  assert.ok(unknownOut.length >= 3, `need Unknown results, got ${unknownOut.length}`);
  const malformed = fixture.cases.filter((c) => ['1ii', 'i', 'xyz', `"\\z"`, `'ab'`, `''`].includes(c.x) || c.form === 'unknown');
  assert.ok(malformed.length >= 3, `need malformed ToInt cases, got ${malformed.length}`);
  const intValued = fixture.cases.filter((c) => c.form === 'quo' && c.kind === 'Int');
  assert.ok(intValued.length >= 3, `need integer-valued Float ToInt, got ${intValued.length}`);
  for (const c of fixture.cases) {
    const got = evaluateConv(c);
    assert.equal(got.origKind, c.origKind, `${c.id} origKind`);
    assert.equal(got.kind, c.kind, `${c.id} kind`);
    assert.equal(got.exact, c.exact, `${c.id} exact`);
    assert.equal(got.sign, c.sign, `${c.id} sign`);
    assert.equal(got.reKind, c.reKind, `${c.id} reKind`);
    assert.equal(got.reExact, c.reExact, `${c.id} reExact`);
    assert.equal(got.imKind, c.imKind, `${c.id} imKind`);
    assert.equal(got.imExact, c.imExact, `${c.id} imExact`);
    assert.equal(got.f64Bits, c.f64Bits, `${c.id} f64Bits`);
    assert.equal(got.f64Exact, c.f64Exact, `${c.id} f64Exact`);
  }
});

test('JS ToInt extras → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    { convert: 'ToInt', form: 'int', x: '5', y: '0', s: '0' },
    { convert: 'ToInt', form: 'quo', x: '5', y: '1', s: '0' },
    { convert: 'ToInt', form: 'quo', x: '1', y: '3', s: '0' },
    { convert: 'ToInt', form: 'char', x: `'π'`, y: '0', s: '0' },
    { convert: 'ToInt', form: 'imag', x: '0i', y: '0', s: '0' },
    { convert: 'ToInt', form: 'string', x: '"', y: '0', s: '0' },
    { convert: 'ToInt', form: 'bool', x: 'false', y: '0', s: '0' },
    { convert: 'ToInt', form: 'sum', x: '-1', y: '0i', s: '0' },
  ];
  const cases = extras.map((c, i) => evaluateConv({ id: `js-toint-${i}`, ...c }));
  const packet = { schema: 1, package: 'gotool', go: 'js', slice: 'constant-toint', cases };
  const verified = go(['-verify-constant-toint'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 8 gotool constant-toint cases/);
  const broken = structuredClone(packet);
  broken.cases[0].exact = 'not-an-int';
  const rejected = go(['-verify-constant-toint'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
  assert.notEqual(go(['-verify-constant-toint'], JSON.stringify({
    schema: 1, package: 'gotool', go: 'js', slice: 'constant-toint', cases: [],
  })).status, 0);
});

test('constToIntValue vs Go: Int identity, 4/2 unwraps, 1/2 Unknown, 0i→0, Bool/String Unknown', () => {
  const one = constMakeInt64(1n);
  const half = constBinaryOp(TOKEN.QUO, one, constMakeInt64(2n));
  const two = constBinaryOp(TOKEN.QUO, constMakeInt64(4n), constMakeInt64(2n));
  const i = constMakeFromLiteral('1i', TOKEN.IMAG, 0);
  const zeroI = constMakeFromLiteral('0i', TOKEN.IMAG, 0);
  const t = constMakeBool(true);
  const s = constMakeFromLiteral('"a"', TOKEN.STRING, 0);
  const ch = constMakeFromLiteral("'a'", TOKEN.CHAR, 0);
  const leftover = constMakeFromLiteral("'ab'", TOKEN.CHAR, 0);
  const unk = constMakeFromLiteral('1ii', TOKEN.IMAG, 0);
  const emptyChar = constMakeFromLiteral("''", TOKEN.CHAR, 0);
  assert.equal(constToIntValue(one).kind, 'Int');
  assert.equal(constToIntValue(one).toString(), '1');
  assert.equal(constToIntValue(half).kind, 'Unknown');
  assert.equal(constToIntValue(two).kind, 'Int');
  assert.equal(constToIntValue(two).toString(), '2');
  assert.equal(constToIntValue(i).kind, 'Unknown');
  assert.equal(constToIntValue(zeroI).kind, 'Int');
  assert.equal(constToIntValue(zeroI).toString(), '0');
  assert.equal(constToIntValue(t).kind, 'Unknown');
  assert.equal(constToIntValue(s).kind, 'Unknown');
  assert.equal(constToIntValue(ch).toString(), '97');
  assert.equal(leftover.kind, 'Int');
  assert.equal(constToIntValue(leftover).toString(), '97');
  assert.equal(unk.kind, 'Unknown');
  assert.equal(constToIntValue(unk).kind, 'Unknown');
  assert.equal(emptyChar.kind, 'Unknown');
  assert.equal(constToIntValue(emptyChar).kind, 'Unknown');
  const [iv, ok] = constToInt(constToIntValue(one));
  assert.equal(iv, 1n);
  assert.equal(ok, true);
  assert.throws(() => constToIntValue(1), TypeError);
});
