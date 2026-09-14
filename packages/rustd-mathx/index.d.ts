/** math/bits. 8/16/32-bit values are unsigned `number`; 64-bit values are `bigint`. */
export function leadingZeros8(x: number): number;
export function leadingZeros16(x: number): number;
export function leadingZeros32(x: number): number;
export function leadingZeros64(x: bigint): number;
export function trailingZeros8(x: number): number;
export function trailingZeros16(x: number): number;
export function trailingZeros32(x: number): number;
export function trailingZeros64(x: bigint): number;
export function onesCount8(x: number): number;
export function onesCount16(x: number): number;
export function onesCount32(x: number): number;
export function onesCount64(x: bigint): number;
export function len8(x: number): number;
export function len16(x: number): number;
export function len32(x: number): number;
export function len64(x: bigint): number;
export function rotateLeft8(x: number, k: number): number;
export function rotateLeft16(x: number, k: number): number;
export function rotateLeft32(x: number, k: number): number;
export function rotateLeft64(x: bigint, k: number): bigint;
export function reverse8(x: number): number;
export function reverse16(x: number): number;
export function reverse32(x: number): number;
export function reverse64(x: bigint): bigint;
export function reverseBytes16(x: number): number;
export function reverseBytes32(x: number): number;
export function reverseBytes64(x: bigint): bigint;
export function add32(x: number, y: number, carry: number): { sum: number; carryOut: number };
export function add64(x: bigint, y: bigint, carry: bigint): { sum: bigint; carryOut: bigint };
export function sub32(x: number, y: number, borrow: number): { diff: number; borrowOut: number };
export function sub64(x: bigint, y: bigint, borrow: bigint): { diff: bigint; borrowOut: bigint };
export function mul32(x: number, y: number): { hi: number; lo: number };
export function mul64(x: bigint, y: bigint): { hi: bigint; lo: bigint };
export function div32(hi: number, lo: number, y: number): { quo: number; rem: number };
export function div64(hi: bigint, lo: bigint, y: bigint): { quo: bigint; rem: bigint };
export function rem32(hi: number, lo: number, y: number): number;
export function rem64(hi: bigint, lo: bigint, y: bigint): bigint;

/** math/cmplx. `Complex` is a readonly `[re, im]` tuple. */
export type Complex = readonly [re: number, im: number];
export function cAbs(x: Complex): number;
export function cArg(x: Complex): number;
export function cNorm(x: Complex): number;
export function cConj(x: Complex): Complex;
export function cRect(r: number, φ: number): Complex;
export function cPolar(x: Complex): { r: number; φ: number };
export function cExp(x: Complex): Complex;
export function cLog(x: Complex): Complex;
export function cPow(x: Complex, y: Complex): Complex;
export function cSqrt(x: Complex): Complex;
export function cSin(x: Complex): Complex;
export function cCos(x: Complex): Complex;
export function cTan(x: Complex): Complex;
export function cSinh(x: Complex): Complex;
export function cCosh(x: Complex): Complex;
export function cTanh(x: Complex): Complex;
export function cAsin(x: Complex): Complex;
export function cAcos(x: Complex): Complex;
export function cAtan(x: Complex): Complex;
export function cAsinh(x: Complex): Complex;
export function cAcosh(x: Complex): Complex;
export function cAtanh(x: Complex): Complex;
export function cCot(x: Complex): Complex;
export function cInf(): Complex;
export function cNaN(): Complex;
export function cIsInf(x: Complex, sign?: number): boolean;
export function cIsNaN(x: Complex): boolean;

/**
 * math/rand v2 PCG / ChaCha8 and v1 lagged-Fibonacci `newSource` (checkpoint 4).
 * This is a PRNG, not a CSPRNG: do not use for tokens, keys, nonces, or session IDs.
 * `defaultRand()` is auto-seeded (ChaCha8 via `crypto.getRandomValues`). `seedDefault` is not exported.
 *
 * 64-bit integers are `bigint` (issue #21 shape 1), including `int()` / `uint()` on this 64-bit port.
 */
export class Rand {
  uint64(): bigint;
  uint64N(n: bigint): bigint;
  uint32(): number;
  uint32N(n: number): number;
  uint(): bigint;
  uintN(n: bigint): bigint;
  int64(): bigint;
  int64N(n: bigint): bigint;
  int32(): number;
  int32N(n: number): number;
  int(): bigint;
  intN(n: number): number;
  /** v1 `Int63`. Throws `RangeError` on PCG/ChaCha8. */
  int63(): bigint;
  int63n(n: bigint): bigint;
  int31(): number;
  int31n(n: number): number;
  intn(n: number): number;
  uint32v1(): number;
  float32(): number;
  /** v2 `Float64` on PCG/ChaCha8; v1 `Float64` on `newSource`. */
  float64(): number;
  /** Standard normal (mean 0, stddev 1). v1 uses `Uint32`; v2 uses `Uint64` (Go ziggurat). */
  normFloat64(): number;
  /** Exponential with λ=1. v1 uses `Uint32`; v2 uses `Uint64` (Go ziggurat). */
  expFloat64(): number;
  /** Copy-and-shuffle. Not an array → `RangeError` (`invalid argument to Shuffle`). */
  shuffle<T>(values: T[]): T[];
  shuffleInPlace(array: Uint32Array | Float64Array): void;
  /** `perm(0)` is empty; `perm(n<0)` throws. v1 uses `Intn`; v2 uses `Shuffle`. */
  perm(n: number): Uint32Array;
  /** v1 deterministic `Read`. Throws `RangeError` on PCG/ChaCha8 (v2 has no Read). */
  read(n: number): Uint8Array;
  /** Go `MarshalBinary` bytes: PCG is 20 bytes (`pcg:` + BE hi/lo); ChaCha8 is 48 bytes (`chacha8:` + BE used + LE seed), optionally prefixed with `readbuf:`. v1 `newSource` has no marshal format and throws. */
  state(): Uint8Array;
}
export function newPCG(seed1: bigint, seed2: bigint): Rand;
export function newChaCha8(seed: Uint8Array): Rand;
/** Go `math/rand.NewSource(seed)` lagged-Fibonacci generator. */
export function newSource(seed: bigint): Rand;
export function randFromState(state: Uint8Array): Rand;
/** Zipf k ∈ [0, imax] with P(k) ∝ (v+k)**(-s). Requires s > 1 and v ≥ 1. Consumes `rnd.float64()`. */
export class Zipf {
  constructor(rnd: Rand, s: number, v: number, imax: number);
  uint64(): bigint;
}
/**
 * Auto-seeded global ChaCha8 (Go 1.20+ `default Source` shape, not `Seed(1)`).
 * This is a PRNG, not a CSPRNG: do not use for tokens, keys, nonces, or session IDs.
 */
export function defaultRand(): Rand;
