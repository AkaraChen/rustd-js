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
 * math/rand v2 PCG / ChaCha8 (checkpoint 1).
 * This is a PRNG, not a CSPRNG: do not use for tokens, keys, nonces, or session IDs.
 * Remaining Rand methods (intN, shuffle, Zipf, v1 Read, defaultRand) land in later checkpoints.
 */
export class Rand {
  uint64(): bigint;
  /** Go `MarshalBinary` bytes: PCG is 20 bytes (`pcg:` + BE hi/lo); ChaCha8 is 48 bytes (`chacha8:` + BE used + LE seed), optionally prefixed with `readbuf:`. */
  state(): Uint8Array;
}
export function newPCG(seed1: bigint, seed2: bigint): Rand;
export function newChaCha8(seed: Uint8Array): Rand;
export function randFromState(state: Uint8Array): Rand;
