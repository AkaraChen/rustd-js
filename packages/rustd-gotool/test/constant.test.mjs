import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  GoConstValue,
  constMakeInt64,
  constToInt,
  constCompare,
  constSign,
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
  assert.throws(() => constUnaryOp(TOKEN.NOT, one, 0), /ADD/);
  assert.throws(() => constUnaryOp(TOKEN.XOR, one, -1), TypeError);
  assert.throws(() => constUnaryOp(TOKEN.XOR, one, 1.5), TypeError);
  assert.throws(() => constShift(TOKEN.ADD, one, 1n), /SHL/);
  assert.throws(() => constShift(TOKEN.SHL, one, -1n), /0\.\.1000000/);
  assert.throws(() => constShift(TOKEN.SHL, one, 1), TypeError);
  assert.throws(() => constBinaryOp(TOKEN.SHL, one, one), /ADD/);
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
