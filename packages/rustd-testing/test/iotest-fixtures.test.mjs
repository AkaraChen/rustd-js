import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esm from '../index.mjs';

const pkgDir = dirname(fileURLToPath(import.meta.url));
const root = join(pkgDir, '..', '..', '..');
const fixturePath = join(pkgDir, 'iotest-fixtures.json');
const require = createRequire(import.meta.url);

function goIotest(args, input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const prefix = command === 'go' ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures/iotestcheck', ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Go exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

test('committed iotest fixtures match live Go 1.24 testing/iotest', () => {
  const raw = readFileSync(fixturePath, 'utf8');
  const packet = JSON.parse(raw);
  assert.equal(packet.schema, 1);
  assert.equal(packet.package, 'iotest');
  assert.match(packet.goVersion, /^go1\.24/);
  assert.equal(packet.sequences.length, 20);
  assert.equal(packet.testReader.length, 3);
  const wraps = new Set(packet.sequences.map((s) => s.wrap));
  assert.deepEqual([...wraps].sort(), ['dataErr', 'err', 'half', 'identity', 'oneByte']);
  const lastDataErr = packet.sequences.find((s) => s.id === 'dataErr/hello/buf3').calls.at(-1);
  assert.equal(lastDataErr.n > 0 && lastDataErr.err === 'EOF', true);
  const merged = packet.sequences.find((s) => s.id === 'dataErr/scripted-last-err/buf8').calls.at(-1);
  assert.equal(merged.n, 2);
  assert.equal(merged.err, 'io failure');
  assert.equal(merged.hex, '6465');
  const half8 = packet.sequences.find((s) => s.id === 'half/hello/buf8').calls[0];
  assert.equal(half8.n, 4); // Go: (len(p)+1)/2, not issue-draft len(p)/2
  const verified = goIotest(['-verify'], raw);
  assert.match(verified, /Go verified 20 iotest sequences and 3 TestReader cases/);
});

test('T harness still does not export iotest readers', () => {
  const cjs = require('../index.js');
  for (const name of ['dataErrReader', 'errReader', 'halfReader', 'oneByteReader', 'testReader']) {
    assert.equal(esm[name], undefined);
    assert.equal(cjs[name], undefined);
  }
});
