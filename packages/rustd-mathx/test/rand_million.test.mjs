import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPCG, newChaCha8 } from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const N = 1_000_000;

function goMillion(outdir) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const args =
    command === 'go'
      ? ['run', 'rand_oracle_million.go', outdir]
      : ['exec', '--', 'go', 'run', 'rand_oracle_million.go', outdir];
  const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`million oracle failed: ${result.stderr}\n${result.stdout}`);
  }
}

function check(buf, make, label) {
  assert.equal(buf.byteLength, N * 8, `${label} size`);
  const r = make();
  for (let i = 0; i < N; i++) {
    const want = buf.readBigUInt64LE(i * 8);
    const got = r.uint64();
    if (got !== want) {
      throw new Error(`${label}[${i}]: got ${got} want ${want}`);
    }
  }
}

test('PCG/ChaCha8 first 1_000_000 uint64 values match Go (issue #21 §4.3)', { timeout: 180_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), 'rustd-mathx-million-'));
  try {
    goMillion(out);
    check(readFileSync(join(out, 'pcg12.bin')), () => newPCG(1n, 2n), 'pcg(1,2)');
    check(readFileSync(join(out, 'pcg00.bin')), () => newPCG(0n, 0n), 'pcg(0,0)');
    const seed = new Uint8Array(32);
    seed[0] = 1;
    check(readFileSync(join(out, 'chacha.bin')), () => newChaCha8(seed), 'chacha8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
