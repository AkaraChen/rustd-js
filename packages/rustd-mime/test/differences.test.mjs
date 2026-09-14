import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../index.mjs';

test('multipart is not exported until rustd-net MIMEHeader lands', () => {
  for (const name of ['MultipartReader', 'MultipartWriter', 'fileContentDisposition', 'MessageTooLargeError']) {
    assert.equal(api[name], undefined, name);
  }
});

test('documented Windows registry difference: no extra lookup API', () => {
  assert.equal(typeof api.typeByExtension, 'function');
  assert.equal(api.typeByRegistry, undefined);
});
