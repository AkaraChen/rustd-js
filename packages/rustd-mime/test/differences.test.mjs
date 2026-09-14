import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../index.mjs';

test('multipart mid-boundary nextPart is in; ReadForm later (checkpoint 18)', () => {
  assert.equal(typeof api.MultipartWriter, 'function');
  assert.equal(typeof api.MultipartWriter.prototype.createFormFile, 'function');
  assert.equal(typeof api.MultipartWriter.prototype.createPart, 'function');
  assert.equal(typeof api.fileContentDisposition, 'function');
  assert.equal(typeof api.MultipartReader.prototype.nextPart, 'function');
  assert.equal(typeof api.MultipartReader.prototype.write, 'function');
  for (const name of ['MessageTooLargeError', 'readForm']) {
    assert.equal(api[name], undefined, name);
  }
  assert.equal(typeof api.canonicalMIMEHeaderKey, 'function');
  assert.equal(typeof api.mimeHeaderGet, 'function');
});

test('documented Windows registry difference: no extra lookup API', () => {
  assert.equal(typeof api.typeByExtension, 'function');
  assert.equal(api.typeByRegistry, undefined);
});
