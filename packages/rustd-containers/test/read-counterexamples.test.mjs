import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SuffixArray, SuffixArrayFormatError } from '../index.mjs';

/** Go `binary.PutVarint` into a 10-byte `maxVarintLen64` slot (`writeInt`). */
function writeInt(x) {
  const n = typeof x === 'bigint' ? x : BigInt(x);
  let ux = n << 1n;
  if (n < 0n) ux = ~ux;
  const buf = Buffer.alloc(10);
  let i = 0;
  while (ux >= 0x80n) {
    buf[i++] = Number(ux & 0x7fn) | 0x80;
    ux >>= 7n;
  }
  buf[i] = Number(ux);
  return buf;
}

function rss() {
  return process.memoryUsage().rss;
}

function assertThrowsFormat(bytes, label) {
  const t0 = performance.now();
  const rss0 = rss();
  assert.throws(() => SuffixArray.read(bytes), SuffixArrayFormatError, label);
  const ms = performance.now() - t0;
  const grew = rss() - rss0;
  assert.ok(ms < 500, `${label}: took ${ms.toFixed(1)}ms (hang?)`);
  assert.ok(grew < 32 * 1024 * 1024, `${label}: RSS grew ${grew} bytes (huge alloc?)`);
}

test('writeInt helper matches Go/native 10-byte length prefix', () => {
  const written = Buffer.from(SuffixArray.build(Buffer.from('a')).write());
  assert.deepEqual(written.subarray(0, 10), writeInt(1));
});

test('SuffixArray.read zero-width chunk throws without hang', { timeout: 2000 }, () => {
  // n=1, 1 data byte, then a slice whose size is exactly maxVarintLen64 (payload 0).
  // A missing got==0 check would spin forever in `while filled < n`.
  const zeroWidth = Buffer.concat([writeInt(1), Buffer.from([0x61]), writeInt(10)]);
  for (let i = 0; i < 1000; i++) {
    assertThrowsFormat(zeroWidth, `zero-width chunk #${i}`);
  }
  // size=0 is also a 0-progress chunk (Go ReadFull(0) then n=0).
  const sizeZero = Buffer.concat([writeInt(1), Buffer.from([0x61]), writeInt(0)]);
  assertThrowsFormat(sizeZero, 'chunk size 0');
});

test('SuffixArray.read truncated payload throws without hang or huge alloc', { timeout: 2000 }, () => {
  assertThrowsFormat(new Uint8Array(3), 'truncated int header');
  assertThrowsFormat(
    Buffer.concat([writeInt(1), Buffer.from([0x61])]),
    'data present, no SA slice',
  );
  assertThrowsFormat(
    Buffer.concat([writeInt(8), Buffer.from('abc')]),
    'data length 8 but only 3 bytes follow',
  );
  // Slice size 100 claims 90 payload bytes; only 3 follow.
  assertThrowsFormat(
    Buffer.concat([writeInt(1), Buffer.from([0x61]), writeInt(100), Buffer.from([1, 2, 3])]),
    'truncated slice payload',
  );
});

test('SuffixArray.read claimed 2^63 / i32::MAX length does not allocate', { timeout: 2000 }, () => {
  const rss0 = rss();
  // zigzag-varint that decodes as a huge positive (existing 10-byte bomb).
  const huge = new Uint8Array(10);
  huge[0] = 0xfe;
  huge[1] = huge[2] = huge[3] = huge[4] = huge[5] = huge[6] = huge[7] = huge[8] = 0xff;
  huge[9] = 0x01;
  assertThrowsFormat(huge, 'claimed ~2^63');
  assertThrowsFormat(writeInt((1n << 63n) - 1n), 'i64::MAX');
  assertThrowsFormat(writeInt(0x7fff_ffff), 'i32::MAX with no data bytes');
  assertThrowsFormat(writeInt(-1), 'negative length');
  const grew = rss() - rss0;
  assert.ok(grew < 64 * 1024 * 1024, `RSS grew ${grew} after claimed-huge reads`);
});
