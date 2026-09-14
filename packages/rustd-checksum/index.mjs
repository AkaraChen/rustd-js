import api from './index.js';
export const {
  ChecksumError, UninitializedSeedError,
  Crc32Table, Crc64Table,
  Adler32, Crc32, Crc64, Fnv32, Fnv32a, Fnv64, Fnv64a, Fnv128, Fnv128a, MapHash,
  adler32, crc32, crc32ieee, crc64,
  fnv32, fnv32a, fnv64, fnv64a, fnv128, fnv128a,
  maphashSeed, maphashBytes, maphashString,
} = api;
