import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeByExtension, extensionsByType, addExtensionType, MediaTypeError } from '../index.mjs';

test('builtin TypeByExtension table matches Go for web types', () => {
  assert.equal(typeByExtension('.json'), 'application/json');
  assert.equal(typeByExtension('.wasm'), 'application/wasm');
  assert.equal(typeByExtension('.html'), 'text/html; charset=utf-8');
  assert.equal(typeByExtension('.HTML'), 'text/html; charset=utf-8');
  assert.ok(extensionsByType('image/jpeg').includes('.jpg'));
});

test('AddExtensionType requires a leading dot and records the mapping', () => {
  assert.throws(
    () => addExtensionType('no-dot', 'application/x-test'),
    (err) => err instanceof MediaTypeError && err.message === 'mime: extension "no-dot" missing leading dot',
  );
  addExtensionType('.rustdmimetest', 'application/x-rustd-mime-test');
  assert.equal(typeByExtension('.rustdmimetest'), 'application/x-rustd-mime-test');
  assert.ok(extensionsByType('application/x-rustd-mime-test').includes('.rustdmimetest'));
});

test('AddExtensionType error strings match Go (issue #9 §3)', () => {
  const cases = [
    ['no-dot', 'application/x-test', 'mime: extension "no-dot" missing leading dot'],
    ['txt', 'text/plain', 'mime: extension "txt" missing leading dot'],
    ['', 'text/plain', 'mime: extension "" missing leading dot'],
    ['.ck7slash', 'not a type', 'mime: expected slash after first token'],
    ['.ck7token', 'bogus/', 'mime: expected token after slash'],
    ['.ck7empty', '/plain', 'mime: no media type'],
    ['.ck7param', 'text/plain; charset', 'mime: invalid media parameter'],
    ['.ck7blank', '', 'mime: no media type'],
  ];
  for (const [ext, typ, message] of cases) {
    assert.throws(
      () => addExtensionType(ext, typ),
      (err) => err instanceof MediaTypeError && err.message === message,
      `${JSON.stringify(ext)} ${JSON.stringify(typ)}`,
    );
  }
});
