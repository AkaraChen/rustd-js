import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../index.mjs';

test('multipart reader still later; writer WriteField/CreateFormField is in (checkpoint 11)', () => {
  assert.equal(typeof api.MultipartWriter, 'function');
  for (const name of ['MultipartReader', 'fileContentDisposition', 'MessageTooLargeError']) {
    assert.equal(api[name], undefined, name);
  }
  assert.equal(typeof api.canonicalMIMEHeaderKey, 'function');
  assert.equal(typeof api.mimeHeaderGet, 'function');
});

test('documented Windows registry difference: no extra lookup API', () => {
  assert.equal(typeof api.typeByExtension, 'function');
  assert.equal(api.typeByRegistry, undefined);
});
