import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { versionCompare, versionIsValid, versionLang } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/gotool', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20, timeout: 120000,
  });
}

function evaluate(c) {
  return {
    ...c,
    compare: versionCompare(c.x, c.y),
    xValid: versionIsValid(c.x),
    yValid: versionIsValid(c.y),
    xLang: versionLang(c.x),
    yLang: versionLang(c.y),
  };
}

test('Go 1.24 regenerates committed go/version fixtures; native matches every case', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(new URL('./go-fixtures.json', import.meta.url), 'utf8');
  assert.equal(generated.stdout, committed, 'Go fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool');
  assert.ok(fixture.cases.length >= 40, `too few cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const got = evaluate(c);
    assert.equal(got.compare, c.compare, `${c.id} compare ${c.x} ${c.y}`);
    assert.equal(got.xValid, c.xValid, `${c.id} xValid`);
    assert.equal(got.yValid, c.yValid, `${c.id} yValid`);
    assert.equal(got.xLang, c.xLang, `${c.id} xLang`);
    assert.equal(got.yLang, c.yLang, `${c.id} yLang`);
  }
});

test('JS generates extra versions → native computes → Go verifies; corruptions fail', () => {
  const extras = [
    ['', 'go1'],
    ['go1.21', 'go1.21.0'],
    ['go1.21rc2', 'go1.21.2'],
    ['go1.23.4-custom', 'go1.23.4'],
    ['go1.20.0-bigcorp', 'go1.21'],
    ['not-a-version', 'go1.2rc3'],
    ['go1.999testmod', 'go2'],
    ['go1.21alpha1', 'go1.21beta1'],
    ['go1.2', 'go1.2.0'],
    ['go1.21.0', 'go1.21.0'],
  ];
  const cases = extras.map(([x, y], i) => evaluate({ id: `js-${i}`, x, y }));
  const packet = { schema: 1, package: 'gotool', go: 'js', cases };
  const verified = go(['-verify'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 10 gotool cases/);
  const broken = structuredClone(packet);
  broken.cases[1].compare = 99;
  const rejected = go(['-verify'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 1/);
  assert.notEqual(go(['-verify'], JSON.stringify({ schema: 1, package: 'gotool', go: 'js', cases: [] })).status, 0);
});

test('non-string versions throw TypeError before native conversion', () => {
  assert.throws(() => versionCompare(1, 'go1'), TypeError);
  assert.throws(() => versionIsValid(null), TypeError);
  assert.throws(() => versionLang(undefined), TypeError);
});
