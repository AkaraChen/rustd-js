import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maphashBytes, maphashSeed } from '../index.mjs';

function popcount64(n) {
  let c = 0n;
  let x = n;
  while (x) { c += x & 1n; x >>= 1n; }
  return Number(c);
}
function chiSquare(counts, expected) {
  let x = 0;
  for (const n of counts) {
    const d = n - expected;
    x += (d * d) / expected;
  }
  return x;
}

test('same seed and input are stable across 100 in-process runs and a child process', () => {
  const seed = 0x0123456789abcdeffedcba987654321n;
  const data = new TextEncoder().encode('maphash-stability');
  const first = maphashBytes(seed, data);
  for (let i = 0; i < 100; i++) assert.equal(maphashBytes(seed, data), first);
  const child = spawnSync(process.execPath, ['-e', `
    const { maphashBytes } = require(${JSON.stringify(fileURLToPath(new URL('../index.js', import.meta.url)))});
    process.stdout.write(String(maphashBytes(${seed}n, Buffer.from('maphash-stability'))));
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(BigInt(child.stdout), first);
});

test('avalanche: flipping 1 input bit flips about 32 of 64 output bits', () => {
  const seed = maphashSeed();
  const samples = 10_000;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const data = new Uint8Array(16);
    for (let j = 0; j < 16; j++) data[j] = (i * 17 + j * 13) & 255;
    const base = maphashBytes(seed, data);
    const bit = i % 128;
    data[bit >> 3] ^= 1 << (bit & 7);
    total += popcount64(base ^ maphashBytes(seed, data));
  }
  const mean = total / samples;
  assert.ok(mean >= 28 && mean <= 36, `avalanche mean ${mean}`);
});

test('chi-square distribution of short strings mod 8/64/1024 has p > 0.01', (t) => {
  const seed = maphashSeed();
  t.diagnostic(`maphash distribution seed=0x${seed.toString(16)}`);
  const n = 1_000_000;
  for (const mod of [8, 64, 1024]) {
    const counts = new Float64Array(mod);
    for (let i = 0; i < n; i++) {
      const h = maphashBytes(seed, Buffer.from(`k${i}`));
      counts[Number(h % BigInt(mod))]++;
    }
    const expected = n / mod;
    const x2 = chiSquare(counts, expected);
    // df = mod-1; p>0.01 critical values: 18.48 / 87.11 / 1131 (approx).
    const critical = { 8: 18.48, 64: 87.11, 1024: 1131 }[mod];
    assert.ok(x2 < critical, `chi-square ${x2} for mod ${mod}`);
  }
});
