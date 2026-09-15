import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import * as bits from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
let cached;
function goOracle() {
  if (cached) return cached;
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const args = command === 'go' ? ['run', 'bits_oracle.go'] : ['exec', '--', 'go', 'run', 'bits_oracle.go'];
  const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`oracle failed: ${result.stderr}`);
  cached = JSON.parse(result.stdout);
  return cached;
}

const unary = {
  8: { leadingZeros: bits.leadingZeros8, trailingZeros: bits.trailingZeros8, onesCount: bits.onesCount8, len: bits.len8, reverse: bits.reverse8 },
  16: { leadingZeros: bits.leadingZeros16, trailingZeros: bits.trailingZeros16, onesCount: bits.onesCount16, len: bits.len16, reverse: bits.reverse16, reverseBytes: bits.reverseBytes16 },
};

const packet = goOracle();

test('math/bits matches Go for 8-bit and 16-bit exhaustive unary ops', () => {
  for (const [name, fn] of Object.entries(unary[8])) {
    for (let x = 0; x < 256; x++) assert.equal(fn(x), packet.unary8[name][x], `${name}8(${x})`);
  }
  for (const [name, fn] of Object.entries(unary[16])) {
    for (let x = 0; x < 65536; x++) assert.equal(fn(x), packet.unary16[name][x], `${name}16(${x})`);
  }
});

test('math/bits matches Go for 32/64-bit boundary sets, rotate, and arithmetic', () => {
  const u32 = packet.unary32;
  for (let i = 0; i < u32.values.length; i++) {
    const x = u32.values[i];
    assert.equal(bits.leadingZeros32(x), u32.ops.leadingZeros[i], `lz32 ${x}`);
    assert.equal(bits.trailingZeros32(x), u32.ops.trailingZeros[i], `tz32 ${x}`);
    assert.equal(bits.onesCount32(x), u32.ops.onesCount[i], `oc32 ${x}`);
    assert.equal(bits.len32(x), u32.ops.len[i], `len32 ${x}`);
    assert.equal(bits.reverse32(x), u32.reverse[i], `rev32 ${x}`);
    assert.equal(bits.reverseBytes32(x), u32.reverseBytes[i], `revb32 ${x}`);
  }
  const u64 = packet.unary64;
  for (let i = 0; i < u64.values.length; i++) {
    const x = BigInt(u64.values[i]);
    assert.equal(bits.leadingZeros64(x), u64.ops.leadingZeros[i], `lz64 ${x}`);
    assert.equal(bits.trailingZeros64(x), u64.ops.trailingZeros[i], `tz64 ${x}`);
    assert.equal(bits.onesCount64(x), u64.ops.onesCount[i], `oc64 ${x}`);
    assert.equal(bits.len64(x), u64.ops.len[i], `len64 ${x}`);
    assert.equal(bits.reverse64(x), BigInt(u64.reverse[i]), `rev64 ${x}`);
    assert.equal(bits.reverseBytes64(x), BigInt(u64.reverseBytes[i]), `revb64 ${x}`);
  }

  const rot = packet.rotate;
  for (let i = 0; i < rot.x8.length; i++) {
    for (let j = 0; j < rot.k.length; j++) {
      assert.equal(bits.rotateLeft8(rot.x8[i], rot.k[j]), rot.r8[i][j]);
      assert.equal(bits.rotateLeft16(rot.x16[i], rot.k[j]), rot.r16[i][j]);
      assert.equal(bits.rotateLeft32(rot.x32[i], rot.k[j]), rot.r32[i][j]);
      assert.equal(bits.rotateLeft64(BigInt(rot.x64[i]), rot.k[j]), BigInt(rot.r64[i][j]));
    }
  }
  assert.equal(bits.rotateLeft64(1n, -1), BigInt(packet.rotateLeft64_1_neg1));
  assert.equal(bits.rotateLeft64(1n, -1), 9223372036854775808n);

  for (const row of packet.arith) {
    const x32 = Number(BigInt(row.x) & 0xffffffffn);
    const y32 = Number(BigInt(row.y) & 0xffffffffn);
    const c32 = Number(BigInt(row.c) & 0xffffffffn);
    const x = BigInt(row.x);
    const y = BigInt(row.y);
    const c = BigInt(row.c);
    assert.deepEqual(bits.add32(x32, y32, c32), { sum: row.add32[0], carryOut: row.add32[1] });
    assert.deepEqual(bits.sub32(x32, y32, c32), { diff: row.sub32[0], borrowOut: row.sub32[1] });
    assert.deepEqual(bits.mul32(x32, y32), { hi: row.mul32[0], lo: row.mul32[1] });
    assert.deepEqual(bits.add64(x, y, c), { sum: BigInt(row.add64[0]), carryOut: BigInt(row.add64[1]) });
    assert.deepEqual(bits.sub64(x, y, c), { diff: BigInt(row.sub64[0]), borrowOut: BigInt(row.sub64[1]) });
    assert.deepEqual(bits.mul64(x, y), { hi: BigInt(row.mul64[0]), lo: BigInt(row.mul64[1]) });
    if (row.div32) {
      assert.deepEqual(bits.div32(c32, x32, y32), { quo: row.div32[0], rem: row.div32[1] });
      assert.equal(bits.rem32(c32, x32, y32), row.rem32);
    }
    if (row.div64) {
      assert.deepEqual(bits.div64(c, x, y), { quo: BigInt(row.div64[0]), rem: BigInt(row.div64[1]) });
      assert.equal(bits.rem64(c, x, y), BigInt(row.rem64));
    }
  }
});

test('div32/div64 throw RangeError with Go panic wording', () => {
  assert.throws(() => bits.div64(1n, 0n, 1n), err => err instanceof RangeError && err.message === 'integer overflow');
  assert.throws(() => bits.div64(0n, 0n, 0n), err => err instanceof RangeError && err.message === 'integer divide by zero');
  assert.throws(() => bits.div32(1, 0, 1), err => err instanceof RangeError && err.message === 'integer overflow');
  assert.throws(() => bits.div32(0, 0, 0), err => err instanceof RangeError && err.message === 'integer divide by zero');
  assert.throws(() => bits.rem64(0n, 1n, 0n), RangeError);
  assert.throws(() => bits.add32(1, 1, 2), err => err instanceof RangeError);
  assert.throws(() => bits.leadingZeros8(256), RangeError);
  assert.throws(() => bits.leadingZeros64(-1n), RangeError);
  assert.throws(() => bits.leadingZeros64(1), RangeError);
  assert.throws(() => bits.rotateLeft8(1, 1.5), RangeError);
});
