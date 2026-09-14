import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWord, MimeWordDecoder, MimeWordError } from '../index.mjs';

test('RFC 2047 encode/decode round-trips mixed header text', () => {
  const decoder = new MimeWordDecoder();
  const word = encodeWord('utf-8', 'François-Jérôme', 'q');
  assert.equal(word, '=?utf-8?q?Fran=C3=A7ois-J=C3=A9r=C3=B4me?=');
  assert.equal(decoder.decode(word), 'François-Jérôme');
  assert.equal(decoder.decodeHeader(`Hello ${word} there`), 'Hello François-Jérôme there');
  const adjacent = `${word} ${encodeWord('utf-8', 'Café', 'b')}`;
  assert.equal(decoder.decodeHeader(adjacent), 'François-JérômeCafé');
});

test('RFC 2047 charsetReader uses TextDecoder for non-default charsets', () => {
  const seen = [];
  const custom = new MimeWordDecoder({
    charsetReader(charset, input) {
      seen.push(charset);
      return new TextEncoder().encode(new TextDecoder(charset).decode(input));
    },
  });
  const word = '=?utf-16le?b?SABpAA==?=';
  assert.equal(custom.decode(word), 'Hi');
  assert.equal(seen[0], 'utf-16le');
});

test('RFC 2047 invalid encoded-word throws', () => {
  assert.throws(() => new MimeWordDecoder().decode('=?UTF-8?A?Test?='), MimeWordError);
});
