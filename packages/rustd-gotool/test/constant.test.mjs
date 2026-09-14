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
