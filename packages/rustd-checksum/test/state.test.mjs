import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Adler32, Crc32, Crc32Table, Crc64, Crc64Table, Fnv128, MapHash,
  adler32, crc32, crc32ieee, crc64, fnv128, maphashBytes, maphashSeed, maphashString,
  ChecksumError, UninitializedSeedError,
} from '../index.mjs';

const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);

test('digest does not change state; reset and clone are independent', () => {
  const h = new Crc32().update(data.subarray(0, 4));
  const first = h.digest32();
  const second = h.digest32();
  assert.equal(first, second);
  h.update(data.subarray(4));
  assert.equal(h.digest32(), crc32ieee(data));
  const fork = new Adler32().update(data.subarray(0, 3));
  const left = fork.clone();
  fork.update(data.subarray(3));
  left.update(new Uint8Array([9, 9]));
  assert.equal(fork.digest32(), adler32(data));
  assert.notEqual(left.digest32(), fork.digest32());
  fork.reset();
  assert.equal(fork.digest32(), 1);
  const dst = new Uint8Array(6).fill(7);
  assert.throws(() => new Fnv128().update(data).digestInto(dst, 2), ChecksumError);
  const room = new Uint8Array(18).fill(7);
  assert.equal(new Fnv128().update(data).digestInto(room, 2), 16);
  assert.deepEqual(room.subarray(2), fnv128(data));
  assert.deepEqual(room.subarray(0, 2), new Uint8Array([7, 7]));
});

test('crc seed continues a previous checksum; illegal poly and zero maphash seed throw', () => {
  const a = crc32ieee(data.subarray(0, 3));
  assert.equal(crc32ieee(data.subarray(3), a), crc32ieee(data));
  const tab = new Crc32Table('ieee');
  assert.equal(tab.update(a, data.subarray(3)), crc32ieee(data));
  const iso = new Crc64Table('iso');
  const part = iso.checksum(data.subarray(0, 5));
  assert.equal(iso.update(part, data.subarray(5)), crc64(data, { poly: 'iso' }));
  for (const poly of [-1, 1.5, 2 ** 32, 'ieee-reversed', null, 0x1_0000_0000]) {
    assert.throws(() => crc32(data, { poly }), ChecksumError);
  }
  assert.throws(() => crc64(data, { poly: -1n }), ChecksumError);
  assert.throws(() => new MapHash(0n), UninitializedSeedError);
  assert.throws(() => maphashBytes(0n, data), UninitializedSeedError);
  assert.throws(() => new MapHash().setSeed(0n), UninitializedSeedError);
  assert.throws(() => crc32(new Uint16Array([1])), TypeError);
  const seeded = new Adler32(99);
  seeded.update(data);
  seeded.reset();
  assert.equal(seeded.digest32(), 99);
});

test('maphash is process-deterministic for a serialized seed and differs across seeds', () => {
  const seed = maphashSeed();
  assert.notEqual(seed, 0n);
  const h = new MapHash(seed).update(data);
  const a = h.digest64();
  assert.equal(h.digest64(), a);
  assert.equal(new MapHash(seed).update(data).digest64(), a);
  assert.equal(maphashBytes(seed, data), a);
  assert.equal(maphashString(seed, 'abc'), new MapHash(seed).updateString('abc').digest64());
  const other = maphashSeed();
  assert.notEqual(maphashBytes(other, data), a);
  h.setSeed(other);
  assert.equal(h.digest64(), new MapHash(other).digest64());
});
