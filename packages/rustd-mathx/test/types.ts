import {
  leadingZeros32, leadingZeros64, rotateLeft64, add32, add64, div64, rem32,
  cAbs, cPolar, cSqrt, cLog10, cIsInf, type Complex,
  newPCG, newChaCha8, newSource, randFromState, Zipf, defaultRand, type Rand,
} from '../index.js';
const lz: number = leadingZeros32(1);
const lz64: number = leadingZeros64(1n);
const rotated: bigint = rotateLeft64(1n, -1);
const sum32: { sum: number; carryOut: number } = add32(1, 2, 0);
const sum64: { sum: bigint; carryOut: bigint } = add64(1n, 2n, 0n);
const div: { quo: bigint; rem: bigint } = div64(0n, 10n, 3n);
const rem: number = rem32(0, 10, 3);
// @ts-expect-error 64-bit inputs are bigint, not number.
leadingZeros64(1);
// @ts-expect-error 32-bit inputs are number, not bigint.
leadingZeros32(1n);
// @ts-expect-error rotate amount is number.
rotateLeft64(1n, 1n);
// @ts-expect-error carry is required.
add32(1, 2);
const z: Complex = [-1, 0];
const abs: number = cAbs(z);
const log10: Complex = cLog10(z);
const polar: { r: number; φ: number } = cPolar(z);
const sqrt: Complex = cSqrt(z);
const inf: boolean = cIsInf(z, 0);
const rng: Rand = newPCG(1n, 2n);
const u: bigint = rng.uint64();
const n64: bigint = rng.uint64N(7n);
const i: bigint = rng.int();
const iN: number = rng.intN(100);
const shuffled: number[] = rng.shuffle([1, 2, 3]);
const perm: Uint32Array = rng.perm(4);
const st: Uint8Array = rng.state();
const c8: Rand = newChaCha8(new Uint8Array(32));
const restored: Rand = randFromState(st);
const v1: Rand = newSource(1n);
const i63: bigint = v1.int63();
const f64: number = v1.float64();
const f32: number = rng.float32();
const bytes: Uint8Array = v1.read(8);
const idx = Uint32Array.of(0, 1, 2);
rng.shuffleInPlace(idx);
const nf: number = rng.normFloat64();
const ef: number = rng.expFloat64();
const zipf: Zipf = new Zipf(rng, 1.1, 1, 100);
const zk: bigint = zipf.uint64();
const globalRng: Rand = defaultRand();
// @ts-expect-error Complex is a two-number tuple, not a number.
cAbs(1);
// @ts-expect-error PCG seeds are bigint.
newPCG(1, 2);
// @ts-expect-error NewSource seed is bigint.
newSource(1);
void [lz, lz64, rotated, sum32, sum64, div, rem, abs, log10, polar, sqrt, inf, u, n64, i, iN, shuffled, perm, c8, restored, i63, f64, f32, bytes, idx, nf, ef, zk, globalRng];
