import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../index.mjs';

test('multipart header-count nextPart is in; ReadForm later (checkpoint 19)', () => {
  assert.equal(typeof api.MultipartWriter, 'function');
  assert.equal(typeof api.MultipartWriter.prototype.createFormFile, 'function');
  assert.equal(typeof api.MultipartWriter.prototype.createPart, 'function');
  assert.equal(typeof api.fileContentDisposition, 'function');
  assert.equal(typeof api.MultipartReader.prototype.nextPart, 'function');
  assert.equal(typeof api.MultipartReader.prototype.write, 'function');
  assert.equal(typeof api.MessageTooLargeError, 'function');
  assert.equal(api.readForm, undefined, 'readForm');
  assert.equal(typeof api.canonicalMIMEHeaderKey, 'function');
  assert.equal(typeof api.mimeHeaderGet, 'function');
});

test('nextPart malformed empty-boundary / missing-colon / missing-closer vs Go (checkpoint 20)', () => {
  assert.equal(typeof api.MultipartError, 'function');
  assert.equal(typeof api.MultipartReader.prototype.nextPart, 'function');
  assert.equal(api.readForm, undefined, 'readForm');
  const empty = new api.MultipartReader({ boundary: '' });
  assert.throws(() => empty.nextPart(), api.MultipartError);
});

test('nextPart overlong boundary / header without CRLF vs Go (checkpoint 21)', () => {
  assert.equal(typeof api.MultipartReader.prototype.nextPart, 'function');
  assert.equal(api.readForm, undefined, 'readForm');
  const long = 'x'.repeat(71);
  const body = Buffer.from(
    `--${long}\r\nContent-Disposition: form-data; name=foo\r\n\r\nhello\r\n--${long}--\r\n`,
  );
  const reader = new api.MultipartReader({ boundary: long });
  reader.write(body);
  const part = reader.nextPart();
  assert.equal(part.formName(), 'foo');
  assert.throws(() => new api.MultipartWriter({ boundary: long }), api.MultipartError);
});

test('documented Windows registry difference: no extra lookup API', () => {
  assert.equal(typeof api.typeByExtension, 'function');
  assert.equal(api.typeByRegistry, undefined);
});
