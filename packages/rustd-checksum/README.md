# rustd-checksum

Synchronous Adler-32, CRC-32, CRC-64, FNV and seeded 64-bit hashes for Node.
Go-compatible values for every algorithm except `maphash`. Runtime Node >=20;
no JavaScript runtime dependencies.

```js
import { adler32, crc32ieee, crc32, Crc32, fnv32a, MapHash, maphashSeed } from 'rustd-checksum';

console.log(adler32(new Uint8Array()));            // 1
console.log(crc32ieee(new Uint8Array([1, 2, 3]))); // 1438416350
const h = new Crc32();
h.update(new Uint8Array([1]));
h.update(new Uint8Array([2, 3]));
console.log(h.digest32());                         // same as crc32ieee
console.log(crc32(new Uint8Array([1, 2, 3]), { poly: 'castagnoli' }));
console.log(fnv32a(new TextEncoder().encode('foobar')) >>> 0);

const seed = maphashSeed();
const map = new MapHash(seed);
map.updateString('key');
console.log(map.digest64());
```

32-bit results are unsigned `number` values in `[0, 2**32-1]`. 64-bit results
are `bigint`. FNV-128 `digest()` is 16 big-endian bytes; `digest128()` is the
same value as `bigint`.

## Reference values

| Call | Result |
| --- | --- |
| `adler32(empty)` | `1` |
| `crc32ieee(empty)` | `0` |
| `fnv32a(empty)` | `0x811c9dc5` |
| `fnv32a("foobar")` | `0xbf9cf968` |
| `fnv64(empty)` | `14695981039346656037n` |

CRC polynomials use Go's reversed / LSB-first constants: IEEE `0xedb88320`,
Castagnoli `0x82f63b78`, Koopman `0xeb31d82e`, CRC-64 ISO
`0xD800000000000000n`, ECMA `0xC96C5795D7870F42n`. `Crc32Table` / `Crc64Table`
hold a 256-entry table; reuse one instance on hot paths.

`digest()` snapshots state. `digestInto(dst, offset?)` writes that snapshot
into `dst`. `update` accepts `Uint8Array` only (Buffer included). Encode
strings with `TextEncoder` except `MapHash.updateString` / `maphashString`.

## Differences from Go

- **`hash/maphash` values are not Go's memhash.** Go seeds are process-local
  and its mixer changes across versions and architectures. This package uses
  SipHash-1-3 with a serializable 128-bit seed (`bigint`, zero is illegal and
  throws `UninitializedSeedError`). Same seed plus same byte sequence is
  deterministic across processes. Do not try to reproduce Go map iteration or
  `maphash` numbers in JavaScript.
- `Xof` is exported as a TypeScript interface only. Go's `hash` package also
  has no XOF implementation.
- CRC `seed` is Go's `Update(crc, table, p)` continuation, not an IEEE init
  constant.

## Errors

`ChecksumError` (`ERR_CHECKSUM`) covers illegal polynomials and out-of-range
integers. `UninitializedSeedError` (`ERR_CHECKSUM_UNINITIALIZED_SEED`) is the
zero-seed case.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **415,760 bytes**.

```text
$ ls -l packages/rustd-checksum/*.node
-rwxrwxr-x 1 akrc akrc 415760 Sep 14 15:31 packages/rustd-checksum/rustd-checksum.linux-x64-gnu.node
```

Cap: 1,500,000 bytes after strip.

## Performance

1 MiB LCG input × 1000 loops, same machine, Rust 1.97.1 / Go 1.24.13:

```text
$ node packages/rustd-checksum/test/benchmark.mjs
native crc32-ieee  91487 ns/op   10424.16 MiB/s
native adler32    364997 ns/op    2612.83 MiB/s
native fnv32a    2252054 ns/op     423.47 MiB/s
go     crc32-ieee 126690 ns/op    7893.22 MiB/s
go     adler32    579021 ns/op    1727.05 MiB/s
go     fnv32a    1864318 ns/op     536.39 MiB/s
```

CRC-32/IEEE is about 1.38× Go (floor 0.80×). Adler-32 is about 1.59× Go (floor 0.60×). FNV has no floor.
