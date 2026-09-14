export interface Hash {
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
}
export interface Hash32 extends Hash { digest32(): number }
export interface Hash64 extends Hash { digest64(): bigint }
export interface Cloner extends Hash { clone(): Cloner }
export interface Xof extends Hash { read(n: number): Uint8Array }

export type Crc32Poly = 'ieee' | 'castagnoli' | 'koopman';
export type Crc64Poly = 'iso' | 'ecma';

export class ChecksumError extends Error { readonly code: string }
export class UninitializedSeedError extends ChecksumError {}

export class Crc32Table {
  constructor(poly: Crc32Poly | number);
  checksum(data: Uint8Array, seed?: number): number;
  update(crc: number, data: Uint8Array): number;
}
export class Crc64Table {
  constructor(poly: Crc64Poly | bigint);
  checksum(data: Uint8Array, seed?: bigint): bigint;
  update(crc: bigint, data: Uint8Array): bigint;
}

export class Adler32 implements Hash32, Cloner {
  constructor(seed?: number);
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest32(): number;
  clone(): Adler32;
}
export class Crc32 implements Hash32, Cloner {
  constructor(table?: Crc32Table);
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest32(): number;
  clone(): Crc32;
}
export class Crc64 implements Hash64, Cloner {
  constructor(table: Crc64Table);
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest64(): bigint;
  clone(): Crc64;
}
export class Fnv32 implements Hash32, Cloner {
  constructor();
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest32(): number;
  clone(): Fnv32;
}
export class Fnv32a implements Hash32, Cloner {
  constructor();
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest32(): number;
  clone(): Fnv32a;
}
export class Fnv64 implements Hash64, Cloner {
  constructor();
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest64(): bigint;
  clone(): Fnv64;
}
export class Fnv64a implements Hash64, Cloner {
  constructor();
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest64(): bigint;
  clone(): Fnv64a;
}
export class Fnv128 implements Hash, Cloner {
  constructor();
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest128(): bigint;
  clone(): Fnv128;
}
export class Fnv128a implements Hash, Cloner {
  constructor();
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest128(): bigint;
  clone(): Fnv128a;
}
export class MapHash implements Hash64, Cloner {
  constructor(seed?: bigint);
  update(data: Uint8Array): this;
  digest(): Uint8Array;
  digestInto(dst: Uint8Array, offset?: number): number;
  reset(): void;
  size(): number;
  blockSize(): number;
  digest64(): bigint;
  clone(): MapHash;
  seed(): bigint;
  setSeed(seed: bigint): void;
  updateString(s: string): this;
  updateComparable(v: number | bigint | string | boolean): this;
}

export function adler32(data: Uint8Array, seed?: number): number;
export function crc32(data: Uint8Array, opts?: { poly?: Crc32Poly | number; table?: Crc32Table; seed?: number }): number;
export function crc32ieee(data: Uint8Array, seed?: number): number;
export function crc64(data: Uint8Array, opts: { poly: Crc64Poly | bigint; table?: Crc64Table; seed?: bigint }): bigint;
export function fnv32(data: Uint8Array): number;
export function fnv32a(data: Uint8Array): number;
export function fnv64(data: Uint8Array): bigint;
export function fnv64a(data: Uint8Array): bigint;
export function fnv128(data: Uint8Array): Uint8Array;
export function fnv128a(data: Uint8Array): Uint8Array;
export function maphashSeed(): bigint;
export function maphashBytes(seed: bigint, b: Uint8Array): bigint;
export function maphashString(seed: bigint, s: string): bigint;
