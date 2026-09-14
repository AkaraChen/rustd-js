import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newPCG, newChaCha8, randFromState } from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const pkg = join(dir, '..');

let cached;
function goOracle() {
  if (cached) return cached;
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const args = command === 'go' ? ['run', 'rand_oracle.go'] : ['exec', '--', 'go', 'run', 'rand_oracle.go'];
  const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`oracle failed: ${result.stderr}`);
  cached = JSON.parse(result.stdout);
  return cached;
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}
function fromHex(s) {
  return Uint8Array.from(Buffer.from(s, 'hex'));
}

const packet = goOracle();

test('newPCG(1n, 2n) first three uint64 values match the issue fixture and Go', () => {
  const r = newPCG(1n, 2n);
  const got = [r.uint64(), r.uint64(), r.uint64()];
  assert.deepEqual(got.map(String), packet.pcg12First3);
  assert.equal(got[0], 14192431797130687760n);
  assert.equal(got[1], 11371241257079532652n);
  assert.equal(got[2], 14470142590855381128n);
});

test('PCG uint64 stream matches Go for 10k samples (seed 1,2 and 0,0)', () => {
  const a = newPCG(1n, 2n);
  const b = newPCG(0n, 0n);
  for (let i = 0; i < packet.pcg12.length; i++) {
    assert.equal(a.uint64(), BigInt(packet.pcg12[i]), `pcg(1,2)[${i}]`);
  }
  for (let i = 0; i < packet.pcg00.length; i++) {
    assert.equal(b.uint64(), BigInt(packet.pcg00[i]), `pcg(0,0)[${i}]`);
  }
});

test('PCG MarshalBinary is 20 bytes and round-trips with Go', () => {
  const fresh = newPCG(1n, 2n);
  assert.equal(hex(fresh.state()), packet.pcg12State);
  assert.equal(fresh.state().byteLength, 20);
  const mid = newPCG(1n, 2n);
  for (let i = 0; i < 100; i++) mid.uint64();
  assert.equal(hex(mid.state()), packet.pcg12MidState);
  const restored = randFromState(fromHex(packet.pcg12MidState));
  assert.equal(restored.uint64(), BigInt(packet.pcg12MidNext));
  assert.equal(mid.uint64(), BigInt(packet.pcg12MidNext));
});

test('ChaCha8 uint64 stream and 48-byte marshal match Go', () => {
  const seed = new Uint8Array(32);
  seed[0] = 1;
  const r = newChaCha8(seed);
  assert.equal(hex(r.state()), packet.chachaState);
  assert.equal(r.state().byteLength, 48);
  for (let i = 0; i < packet.chacha.length; i++) {
    assert.equal(r.uint64(), BigInt(packet.chacha[i]), `chacha[${i}]`);
  }
  const mid = newChaCha8(seed);
  for (let i = 0; i < 100; i++) mid.uint64();
  assert.equal(hex(mid.state()), packet.chachaMidState);
  const restored = randFromState(fromHex(packet.chachaMidState));
  assert.equal(restored.uint64(), BigInt(packet.chachaMidNext));
});

test('ChaCha8 readbuf: prefix from Go UnmarshalBinary continues the stream', () => {
  assert.match(packet.chachaReadState, /^726561646275663a/); // ASCII "readbuf:"
  const restored = randFromState(fromHex(packet.chachaReadState));
  assert.equal(hex(restored.state()), packet.chachaReadState);
  assert.equal(restored.uint64(), BigInt(packet.chachaReadNext));
});

test('newChaCha8 rejects non-32-byte seeds', () => {
  assert.throws(() => newChaCha8(new Uint8Array(31)), RangeError);
  assert.throws(() => newChaCha8(new Uint8Array(0)), RangeError);
  assert.throws(() => randFromState(new Uint8Array([1, 2, 3])), RangeError);
});

test('release .node stays under 2MB (expected << 500KB)', () => {
  const binary = join(pkg, 'rustd-mathx.linux-x64-gnu.node');
  const size = statSync(binary).size;
  assert.ok(size <= 2 * 1024 * 1024, `size ${size}`);
  assert.ok(size < 500 * 1024, `size ${size} suggests unexpected deps`);
});
