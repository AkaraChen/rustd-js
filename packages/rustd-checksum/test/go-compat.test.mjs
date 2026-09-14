import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { fixtures, compareFromGo, verifyFromJs } from '../../../scripts/compare-with-go.ts';
import {
  Adler32, Crc32, Crc32Table, Crc64, Crc64Table, Fnv32, Fnv32a, Fnv64, Fnv64a, Fnv128, Fnv128a,
  adler32, crc32, crc32ieee, crc64, fnv32, fnv32a, fnv64, fnv64a, fnv128, fnv128a,
} from '../index.mjs';
import { evaluate } from './adapter.mjs';

test('Go generates checksum fixtures; native matches all 13 algorithms including incremental splits', () => {
  assert.equal(compareFromGo(fixtures('checksum'), evaluate), 8);
});

test('JS generates inputs → native digests → Go independently verifies', () => {
  assert.match(verifyFromJs('checksum', evaluate), /Go verified 6 checksum cases/);
});

test('one-shot helpers match streaming hashes and Go empty-input constants', () => {
  const empty = new Uint8Array();
  assert.equal(adler32(empty), 1);
  assert.equal(crc32ieee(empty), 0);
  assert.equal(fnv32(empty), 2166136261);
  assert.equal(fnv32a(empty), 2166136261);
  assert.equal(fnv64(empty), 14695981039346656037n);
  const data = Uint8Array.from({ length: 257 }, (_, i) => (i * 13) & 255);
  assert.equal(adler32(data), new Adler32().update(data).digest32());
  assert.equal(crc32(data), new Crc32().update(data).digest32());
  assert.equal(crc32(data, { poly: 'castagnoli' }), new Crc32(new Crc32Table('castagnoli')).update(data).digest32());
  assert.equal(crc32(data, { poly: 'koopman' }), new Crc32(new Crc32Table('koopman')).update(data).digest32());
  assert.equal(crc32(data, { poly: 0xa833982b }), new Crc32(new Crc32Table(0xa833982b)).update(data).digest32());
  assert.equal(crc64(data, { poly: 'ecma' }), new Crc64(new Crc64Table('ecma')).update(data).digest64());
  assert.equal(fnv32(data), new Fnv32().update(data).digest32());
  assert.equal(fnv32a(data), new Fnv32a().update(data).digest32());
  assert.equal(fnv64(data), new Fnv64().update(data).digest64());
  assert.equal(fnv64a(data), new Fnv64a().update(data).digest64());
  assert.deepEqual(fnv128(data), new Fnv128().update(data).digest());
  assert.deepEqual(fnv128a(data), new Fnv128a().update(data).digest());
});

test('IEEE CRC-32 matches Node zlib.crc32; FNV-1a matches public vectors', () => {
  const samples = ['', 'a', '123456789', 'hello world', '你好'];
  for (const s of samples) {
    const data = new TextEncoder().encode(s);
    assert.equal(crc32ieee(data), zlibCrc32(data) >>> 0, s);
  }
  assert.equal(fnv32a(new Uint8Array()), 0x811c9dc5);
  assert.equal(fnv32a(new TextEncoder().encode('a')), 0xe40c292c);
  assert.equal(fnv32a(new TextEncoder().encode('foobar')), 0xbf9cf968);
});
