import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../index.mjs';

test('multipart is not exported until after MIMEHeader (checkpoint 10)', () => {
  for (const name of ['MultipartReader', 'MultipartWriter', 'fileContentDisposition', 'MessageTooLargeError']) {
    assert.equal(api[name], undefined, name);
  }
  assert.equal(typeof api.canonicalMIMEHeaderKey, 'function');
  assert.equal(typeof api.mimeHeaderGet, 'function');
});

test('documented Windows registry difference: no extra lookup API', () => {
  assert.equal(typeof api.typeByExtension, 'function');
  assert.equal(api.typeByRegistry, undefined);
});
