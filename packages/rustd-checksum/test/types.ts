import {
  Adler32, Crc32, Crc32Table, Crc64, Crc64Table, Fnv128, Fnv32a, MapHash,
  adler32, crc32, crc32ieee, crc64, fnv128, fnv64a, maphashBytes, maphashSeed,
  ChecksumError, UninitializedSeedError, type Hash32, type Hash64, type Xof,
} from '../index.js';
const h: Hash32 = new Adler32();
const n: number = h.update(new Uint8Array([1])).digest32();
const ieee: number = crc32ieee(new Uint8Array());
const custom: number = crc32(new Uint8Array([1]), { poly: 0xa833982b, seed: 0 });
const table = new Crc32Table('castagnoli');
const streamed: Hash32 = new Crc32(table);
const c64: Hash64 = new Crc64(new Crc64Table('ecma'));
const wide: bigint = crc64(new Uint8Array(), { poly: 'iso' });
const fnv: bigint = fnv64a(new Uint8Array([1]));
const bytes128: Uint8Array = fnv128(new Uint8Array());
const big128: bigint = new Fnv128().digest128();
const seed: bigint = maphashSeed();
const hashed: bigint = maphashBytes(seed, new Uint8Array([9]));
const map = new MapHash(seed);
map.updateString('ok').updateComparable(true);
const cloned: MapHash = map.clone();
const written: number = h.digestInto(new Uint8Array(8), 2);
const err: ChecksumError = new UninitializedSeedError('zero seed');
const a32: number = adler32(new Uint8Array(), 1);
const fnva: Fnv32a = new Fnv32a();
// @ts-expect-error strings must be encoded by the caller
adler32('abc');
// @ts-expect-error 32-bit results are numbers, not bigint
const wrong: bigint = crc32ieee(new Uint8Array());
// @ts-expect-error 64-bit results are bigint
const narrow: number = fnv;
// @ts-expect-error XOF is an interface only
const xof: Xof = new Adler32();
// @ts-expect-error crc64 requires options
crc64(new Uint8Array());
void [n, ieee, custom, streamed, c64, wide, bytes128, big128, hashed, cloned, written, err, a32, fnva];
