import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, compareFromGo, verifyFromJs, templateAdapter } from '../../../scripts/compare-with-go.ts';
import { echoBytes } from '../index.mjs';
const evaluate = templateAdapter();
test('Go generates → native reads bytes (empty, boundaries, 1 MiB)', () => {
  assert.equal(compareFromGo(fixtures('template'), evaluate), 8);
});
test('JS generates → native output → Go verifies bytes', () => {
  assert.match(verifyFromJs('template', evaluate), /Go verified 6 template cases/);
});
test('native respects typed-array slices and returns an independent array', () => {
  const source = new Uint8Array([9, 1, 2, 9]);
  const output = echoBytes(source.subarray(1, 3));
  assert.deepEqual([...output], [1, 2]);
  output[0] = 77;
  assert.equal(source[1], 1);
  source[2] = 88;
  assert.equal(output[1], 2);
});
