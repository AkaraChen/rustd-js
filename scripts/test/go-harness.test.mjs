import test from 'node:test';
import assert from 'node:assert/strict';
import { go, fixtures, assertResults } from '../compare-with-go.ts';
test('Go checksum fixture has all 13 algorithms and matches incremental writes', () => {
  const packet = fixtures('checksum');
  assert.equal(packet.cases.length, 8);
  for (const c of packet.cases) {
    assert.equal(Object.keys(c.expected).length, 13);
    assert.deepEqual(c.incremental, c.expected);
  }
});
test('Go rejects corrupt JS output with a reproducer', () => {
  assert.throws(() => go(['-pkg', 'template', '-verify'], JSON.stringify({
    schema: 1, package: 'template', cases: [{ id: 'corrupt', hex: '01', expected: { echo: '02' } }],
  })), /corrupt\/echo.*expected 01 got 02.*input hex=01/);
});
test('Go rejects empty verification and missing checksum fields', () => {
  assert.throws(() => go(['-pkg', 'template', '-verify'], '{"schema":1,"package":"template","cases":[]}'), /empty cases/);
  assert.throws(() => go(['-pkg', 'checksum', '-verify'], JSON.stringify({
    schema:1, package:'checksum', cases:[{ id:'missing', hex:'', expected:{} }],
  })), /field count differs/);
});
test('JS rejects missing and unexpected fields with the smallest fixture context', () => {
  assert.throws(() => assertResults('small', { a:'01' }, {}, 'ff'), /small\/a.*hex=ff/);
  assert.throws(() => assertResults('small', {}, { a:'01' }, 'ff'), /small\/a.*hex=ff/);
});
