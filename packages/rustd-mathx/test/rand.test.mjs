import { hostBinaryName } from '../../../scripts/native-test-tools.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newPCG, newChaCha8, newSource, randFromState, Zipf, defaultRand } from '../index.mjs';

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

function f64bits(x) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(x, 0);
  return buf.readBigUInt64LE(0).toString(16);
}

test('newSource(1) first Int63 values match the issue fixture and Go', () => {
  const r = newSource(1n);
  const got = [r.int63(), r.int63()];
  assert.equal(got[0], 5577006791947779410n);
  assert.equal(got[1], 8674665223082153551n);
  assert.equal(got[0], BigInt(packet.v1Seed1Int63[0]));
  assert.equal(got[1], BigInt(packet.v1Seed1Int63[1]));
});

test('v1 Int63 stream matches Go for 10k samples (NewSource(1))', () => {
  const r = newSource(1n);
  for (let i = 0; i < packet.v1Seed1Int63.length; i++) {
    assert.equal(r.int63(), BigInt(packet.v1Seed1Int63[i]), `int63[${i}]`);
  }
});

test('v1 Float64 bit patterns match Go for 10k samples (NewSource(1))', () => {
  const r = newSource(1n);
  for (let i = 0; i < packet.v1Seed1Float64.length; i++) {
    assert.equal(f64bits(r.float64()), packet.v1Seed1Float64[i], `float64[${i}]`);
  }
});

test('v1 Read is deterministic and matches Go including leftover bytes', () => {
  const a = newSource(1n);
  assert.equal(hex(a.read(8)), packet.v1Seed1Read8);
  assert.equal(packet.v1Seed1Read8, '52fdfc072182654f');
  const b = newSource(1n);
  assert.equal(hex(b.read(64)), packet.v1Seed1Read64);
  const c = newSource(1n);
  const first = c.read(3);
  const second = c.read(8);
  assert.equal(hex(Buffer.concat([Buffer.from(first), Buffer.from(second)])), packet.v1Seed1Read3Then8);
  assert.equal(newSource(1n).read(0).byteLength, 0);
});

test('v1 Seed(0) and Seed(-1) Int63 heads match Go', () => {
  const z = newSource(0n);
  for (let i = 0; i < packet.v1Seed0Int63Head.length; i++) {
    assert.equal(z.int63(), BigInt(packet.v1Seed0Int63Head[i]), `seed0[${i}]`);
  }
  const n = newSource(-1n);
  for (let i = 0; i < packet.v1SeedNeg1Int63Head.length; i++) {
    assert.equal(n.int63(), BigInt(packet.v1SeedNeg1Int63Head[i]), `seed-1[${i}]`);
  }
});

test('v1 APIs throw on PCG/ChaCha8; v1 has no MarshalBinary', () => {
  const pcg = newPCG(1n, 2n);
  assert.throws(() => pcg.int63(), RangeError);
  assert.throws(() => pcg.int63n(1n), RangeError);
  assert.throws(() => pcg.intn(1), RangeError);
  assert.throws(() => pcg.read(8), RangeError);
  const v1 = newSource(1n);
  assert.throws(() => v1.state(), RangeError);
  assert.throws(() => newSource(1n << 64n), RangeError);
});

function f32bits(x) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(x, 0);
  return buf.readUInt32LE(0).toString(16);
}

test('PCG uint64N/intN family matches Go consumption', () => {
  const n7 = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Uint64N7.length; i++) {
    assert.equal(n7.uint64N(7n), BigInt(packet.pcg12Uint64N7[i]), `uint64N(7)[${i}]`);
  }
  const pow2 = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Uint64NPow2.length; i++) {
    assert.equal(pow2.uint64N(1024n), BigInt(packet.pcg12Uint64NPow2[i]), `uint64N(1024)[${i}]`);
  }
  const u32 = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Uint32.length; i++) {
    assert.equal(u32.uint32(), packet.pcg12Uint32[i] >>> 0, `uint32[${i}]`);
  }
  const u32n = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Uint32N10.length; i++) {
    assert.equal(u32n.uint32N(10), packet.pcg12Uint32N10[i], `uint32N[${i}]`);
  }
  const intn = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12IntN100.length; i++) {
    assert.equal(intn.intN(100), packet.pcg12IntN100[i], `intN[${i}]`);
  }
  const i32 = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Int32.length; i++) {
    assert.equal(i32.int32(), packet.pcg12Int32[i], `int32[${i}]`);
  }
  const i32n = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Int32N7.length; i++) {
    assert.equal(i32n.int32N(7), packet.pcg12Int32N7[i], `int32N[${i}]`);
  }
  const i64n = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Int64N.length; i++) {
    assert.equal(i64n.int64N(1n << 40n), BigInt(packet.pcg12Int64N[i]), `int64N[${i}]`);
  }
  const i64 = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Int64.length; i++) {
    assert.equal(i64.int64(), BigInt(packet.pcg12Int64[i]), `int64[${i}]`);
  }
  const intv = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Int.length; i++) {
    assert.equal(intv.int(), BigInt(packet.pcg12Int[i]), `int[${i}]`);
  }
  const uintv = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Uint.length; i++) {
    assert.equal(uintv.uint(), BigInt(packet.pcg12Uint[i]), `uint[${i}]`);
  }
});

test('PCG/ChaCha8 float32/float64 bit patterns match Go', () => {
  const f64 = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Float64.length; i++) {
    assert.equal(f64bits(f64.float64()), packet.pcg12Float64[i], `pcg f64[${i}]`);
  }
  const f32 = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Float32.length; i++) {
    assert.equal(f32bits(f32.float32()), packet.pcg12Float32[i], `pcg f32[${i}]`);
  }
  const seed = new Uint8Array(32);
  seed[0] = 1;
  const c64 = newChaCha8(seed);
  for (let i = 0; i < packet.chachaFloat64.length; i++) {
    assert.equal(f64bits(c64.float64()), packet.chachaFloat64[i], `chacha f64[${i}]`);
  }
  const cN = newChaCha8(seed);
  for (let i = 0; i < packet.chachaUint64N3.length; i++) {
    assert.equal(cN.uint64N(3n), BigInt(packet.chachaUint64N3[i]), `chacha uint64N[${i}]`);
  }
});

test('PCG perm and shuffle match Go for n=0/1/2/1000/10000', () => {
  const p = newPCG(1n, 2n);
  for (const n of [0, 1, 2, 1000, 10000]) {
    assert.deepEqual(Array.from(p.perm(n)), packet[`pcg12Perm${n}`], `perm(${n})`);
  }
  const s = newPCG(1n, 2n);
  for (const n of [0, 1, 2, 1000, 10000]) {
    const values = Array.from({ length: n }, (_, i) => i);
    assert.deepEqual(s.shuffle(values), packet[`pcg12Shuffle${n}`], `shuffle(${n})`);
  }
  const t = newPCG(1n, 2n);
  for (const n of [0, 1, 2, 1000, 10000]) {
    const arr = Uint32Array.from({ length: n }, (_, i) => i);
    t.shuffleInPlace(arr);
    assert.deepEqual(Array.from(arr), packet[`pcg12Shuffle${n}`], `shuffleInPlace(${n})`);
  }
});

test('v1 int63n/int31/intn/uint32v1/float32/perm/shuffle match Go', () => {
  const a = newSource(1n);
  for (let i = 0; i < packet.v1Int63n100.length; i++) {
    assert.equal(a.int63n(100n), BigInt(packet.v1Int63n100[i]), `int63n[${i}]`);
  }
  const b = newSource(1n);
  for (let i = 0; i < packet.v1Int31.length; i++) {
    assert.equal(b.int31(), packet.v1Int31[i], `int31[${i}]`);
  }
  const c = newSource(1n);
  for (let i = 0; i < packet.v1Int31n10.length; i++) {
    assert.equal(c.int31n(10), packet.v1Int31n10[i], `int31n[${i}]`);
  }
  const d = newSource(1n);
  for (let i = 0; i < packet.v1Intn50.length; i++) {
    assert.equal(d.intn(50), packet.v1Intn50[i], `intn[${i}]`);
  }
  const e = newSource(1n);
  for (let i = 0; i < packet.v1Uint32.length; i++) {
    assert.equal(e.uint32v1(), packet.v1Uint32[i] >>> 0, `uint32v1[${i}]`);
  }
  const f = newSource(1n);
  for (let i = 0; i < packet.v1Float32.length; i++) {
    assert.equal(f32bits(f.float32()), packet.v1Float32[i], `v1 f32[${i}]`);
  }
  const p = newSource(1n);
  for (const n of [0, 1, 2, 1000, 10000]) {
    assert.deepEqual(Array.from(p.perm(n)), packet[`v1Perm${n}`], `v1 perm(${n})`);
  }
  const s = newSource(1n);
  for (const n of [0, 1, 2, 1000, 10000]) {
    const values = Array.from({ length: n }, (_, i) => i);
    assert.deepEqual(s.shuffle(values), packet[`v1Shuffle${n}`], `v1 shuffle(${n})`);
  }
});

test('N-family and shuffle throw RangeError on Go panic inputs', () => {
  const r = newPCG(1n, 2n);
  assert.throws(() => r.uint64N(0n), RangeError);
  assert.throws(() => r.int64N(0n), RangeError);
  assert.throws(() => r.intN(0), RangeError);
  assert.throws(() => r.shuffle(-1), RangeError);
  assert.throws(() => r.perm(-1), RangeError);
  assert.equal(r.perm(0).byteLength, 0);
});

test('PCG/ChaCha8/v1 normFloat64 and expFloat64 match Go ziggurat bits', () => {
  const n = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Norm.length; i++) {
    assert.equal(f64bits(n.normFloat64()), packet.pcg12Norm[i], `pcg norm[${i}]`);
  }
  const e = newPCG(1n, 2n);
  for (let i = 0; i < packet.pcg12Exp.length; i++) {
    assert.equal(f64bits(e.expFloat64()), packet.pcg12Exp[i], `pcg exp[${i}]`);
  }
  const seed = new Uint8Array(32);
  seed[0] = 1;
  const c = newChaCha8(seed);
  for (let i = 0; i < packet.chachaNormHead.length; i++) {
    assert.equal(f64bits(c.normFloat64()), packet.chachaNormHead[i], `chacha norm[${i}]`);
  }
  const vn = newSource(1n);
  for (let i = 0; i < packet.v1Norm.length; i++) {
    assert.equal(f64bits(vn.normFloat64()), packet.v1Norm[i], `v1 norm[${i}]`);
  }
  const ve = newSource(1n);
  for (let i = 0; i < packet.v1Exp.length; i++) {
    assert.equal(f64bits(ve.expFloat64()), packet.v1Exp[i], `v1 exp[${i}]`);
  }
});

test('Go example_test consumption: ExpFloat64/NormFloat64 after 3 float32 + 3 float64', () => {
  const v2 = newPCG(1n, 2n);
  v2.float32(); v2.float32(); v2.float32();
  v2.float64(); v2.float64(); v2.float64();
  for (let i = 0; i < 3; i++) {
    assert.equal(f64bits(v2.expFloat64()), packet.pcg12ExampleExp3[i], `example exp[${i}]`);
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(f64bits(v2.normFloat64()), packet.pcg12ExampleNorm3[i], `example norm[${i}]`);
  }
  const v1 = newSource(99n);
  v1.float32(); v1.float32(); v1.float32();
  v1.float64(); v1.float64(); v1.float64();
  for (let i = 0; i < 3; i++) {
    assert.equal(f64bits(v1.expFloat64()), packet.v1Seed99Exp3[i], `v1 example exp[${i}]`);
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(f64bits(v1.normFloat64()), packet.v1Seed99Norm3[i], `v1 example norm[${i}]`);
  }
});

test('Zipf uint64 stream matches Go for s=1.1 v=1 imax=100 (PCG and v1)', () => {
  const z = new Zipf(newPCG(1n, 2n), 1.1, 1, 100);
  for (let i = 0; i < packet.pcg12Zipf.length; i++) {
    assert.equal(z.uint64(), BigInt(packet.pcg12Zipf[i]), `pcg zipf[${i}]`);
  }
  const v1 = new Zipf(newSource(1n), 1.1, 1, 100);
  for (let i = 0; i < packet.v1Zipf.length; i++) {
    assert.equal(v1.uint64(), BigInt(packet.v1Zipf[i]), `v1 zipf[${i}]`);
  }
  assert.throws(() => new Zipf(newPCG(1n, 2n), 1, 1, 100), RangeError);
  assert.throws(() => new Zipf(newPCG(1n, 2n), 1.1, 0.5, 100), RangeError);
  assert.throws(() => new Zipf(newPCG(1n, 2n), 1.1, 1, -1), RangeError);
  assert.throws(() => new Zipf({}, 1.1, 1, 100), RangeError);
});

test('seedDefault is not exported (Go math/rand/v2 has no Seed)', async () => {
  const esm = await import('../index.mjs');
  assert.equal(Object.hasOwn(esm, 'seedDefault'), false);
  assert.equal(esm.seedDefault, undefined);
  const { createRequire } = await import('node:module');
  const cjs = createRequire(import.meta.url)('../index.js');
  assert.equal(Object.hasOwn(cjs, 'seedDefault'), false);
  assert.equal(cjs.seedDefault, undefined);
});

test('defaultRand is a singleton auto-seeded ChaCha8, not Seed(1) / PCG(1,2)', () => {
  const a = defaultRand();
  const b = defaultRand();
  assert.equal(a, b);
  const st = a.state();
  assert.equal(st.byteLength, 48);
  assert.equal(Buffer.from(st.subarray(0, 8)).toString(), 'chacha8:');
  assert.notEqual(a.uint64(), 14192431797130687760n);
  assert.throws(() => a.int63(), RangeError);
  const x = defaultRand().uint64();
  const y = defaultRand().uint64();
  assert.notEqual(x, y);
});

test('release .node stays under 2MB (expected << 500KB)', () => {
  const binary = join(pkg, hostBinaryName('rustd-mathx'));
  const size = statSync(binary).size;
  assert.ok(size <= 2 * 1024 * 1024, `size ${size}`);
  assert.ok(size < 500 * 1024, `size ${size} suggests unexpected deps`);
});
