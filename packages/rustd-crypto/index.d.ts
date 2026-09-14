/** Algorithms implemented in checkpoint 1. MD5 and SHA-1 require allowLegacy. */
export type HashAlgo = 'md5' | 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512' | 'sha512-224' | 'sha512-256';
export interface CryptoOptions { allowLegacy?: boolean }
export class CryptoError extends Error { readonly code: string }
export class UnsupportedAlgorithmError extends CryptoError {}
export class InsecureAlgorithmError extends CryptoError {}
export class HashFinalizedError extends CryptoError {}
export interface Hash {
  update(data: Uint8Array | string): this;
  /** Finalizes; update/digest/sum/clone then throw HashFinalizedError until reset. */
  digest(): Uint8Array;
  digest(enc: 'hex' | 'base64' | 'base64url'): string;
  /** Copies prefix and appends a state snapshot, leaving the hash writable. */
  sum(prefix?: Uint8Array): Uint8Array;
  /** No current algorithm is an XOF; throws UnsupportedAlgorithmError. */
  squeeze(n: number): Uint8Array;
  /** Clones native chaining state without retaining or replaying input. */
  clone(): Hash;
  reset(): void;
  readonly size: number;
  readonly blockSize: number;
}
export interface Mac {
  update(data: Uint8Array | string): this;
  digest(): Uint8Array;
  sum(prefix?: Uint8Array): Uint8Array;
  /** Restores the initial keyed state, including after digest. */
  reset(): void;
  readonly size: number;
}
export function createHash(algo: HashAlgo, options?: CryptoOptions): Hash;
export function hash(algo: HashAlgo, data: Uint8Array | string, options?: CryptoOptions): Uint8Array;
export function createHmac(algo: HashAlgo, key: Uint8Array, options?: CryptoOptions): Mac;
/** Native comparison; lengths are public. No timing guarantee for JS callers. */
export function hmacEqual(a: Uint8Array, b: Uint8Array): boolean;
/** Implemented algorithms, including ones gated by allowLegacy. */
export function availableAlgos(): readonly HashAlgo[];
/** This package has no FIPS-validated backend or FIPS mode. */
export function fips140Enabled(): false;
