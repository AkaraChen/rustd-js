import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaType, formatMediaType, InvalidMediaParameterError, MediaTypeError } from '../index.mjs';

test('ParseMediaType copies Go RFC 2231 continuations and quoted escapes', () => {
  const { mediaType, params } = parseMediaType(
    `application/x-stuff; title*0*=us-ascii'en'This%20is%20even%20more%20; title*1*=%2A%2A%2Afun%2A%2A%2A%20; title*2="isn't it!"`,
  );
  assert.equal(mediaType, 'application/x-stuff');
  assert.equal(params.title, "This is even more ***fun*** isn't it!");
  const msie = parseMediaType(`attachment; filename="C:\\dev\\go\\robots.txt"`);
  assert.equal(msie.params.filename, 'C:\\dev\\go\\robots.txt');
});

test('invalid parameters throw InvalidMediaParameterError with mediaType', () => {
  assert.throws(() => parseMediaType('text/plain; charset'), InvalidMediaParameterError);
  try {
    parseMediaType('text/plain; charset');
  } catch (err) {
    assert.equal(err.mediaType, 'text/plain');
    assert.deepEqual(err.params, {});
  }
});

test('duplicate unequal parameters fail the whole type', () => {
  assert.throws(() => parseMediaType('foo; key=val1; key=other'), MediaTypeError);
});

test('FormatMediaType lowercases type and RFC 2231-encodes non-ASCII', () => {
  assert.equal(formatMediaType('Text/Plain', { charset: 'utf-8' }), 'text/plain; charset=utf-8');
  assert.equal(formatMediaType('application/x-stuff', { title: 'This is ***fun***' }), 'application/x-stuff; title="This is ***fun***"');
  assert.match(formatMediaType('application/x-stuff', { title: 'This is fun€' }), /title\*=utf-8''This%20is%20fun%E2%82%AC/);
});
