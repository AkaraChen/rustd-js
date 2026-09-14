import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../index.mjs';

test('multipart nextPart is in; 1-byte feed and ReadForm later (checkpoint 12)', () => {
  assert.equal(typeof api.MultipartWriter, 'function');
  assert.equal(typeof api.MultipartReader, 'function');
  assert.equal(typeof api.MultipartPart, 'function');
  for (const name of ['fileContentDisposition', 'MessageTooLargeError', 'readForm']) {
    assert.equal(api[name], undefined, name);
  }
  assert.equal(typeof api.canonicalMIMEHeaderKey, 'function');
  assert.equal(typeof api.mimeHeaderGet, 'function');
});

test('documented Windows registry difference: no extra lookup API', () => {
  assert.equal(typeof api.typeByExtension, 'function');
  assert.equal(api.typeByRegistry, undefined);
});
