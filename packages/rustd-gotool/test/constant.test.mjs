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
