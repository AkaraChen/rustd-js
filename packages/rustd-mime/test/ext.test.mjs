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
  assert.throws(() => addExtensionType('no-dot', 'application/x-test'), MediaTypeError);
  addExtensionType('.rustdmimetest', 'application/x-rustd-mime-test');
  assert.equal(typeByExtension('.rustdmimetest'), 'application/x-rustd-mime-test');
  assert.ok(extensionsByType('application/x-rustd-mime-test').includes('.rustdmimetest'));
});
