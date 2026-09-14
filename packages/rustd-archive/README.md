# rustd-archive

Synchronous tar and zip archives for Node, implemented in Rust and exposed
through Node-API. Covers Go `archive/tar` and `archive/zip` (issue #2). Runtime
Node >=20. No JavaScript runtime dependencies. Native classes are private.

```js
import { tarCreate, tarExtract, zipCreate, zipExtract, TarReader } from 'rustd-archive';

const tar = tarCreate([
  { name: 'hello.txt', data: new TextEncoder().encode('hi'), mode: 0o644 },
  { name: 'dir/', type: 'dir', mode: 0o755 },
]);
const files = tarExtract(tar);

const zip = zipCreate([
  { name: 'hello.txt', method: 8, data: new TextEncoder().encode('hi') },
]);
```

Whole-buffer APIs (`tarCreate` / `tarExtract` / `zipCreate` / `zipExtract`) copy
bytes into independent `Uint8Array` values. Streaming `TarReader` / `ZipReader`
emit `entry` events; `TarWriter` / `ZipWriter` build an archive in memory and
`end()` returns the bytes. Readers and writers do not hold file descriptors and
do not need `close()`.

## Formats

| Format | Read | Write |
| --- | --- | --- |
| tar ustar | yes | yes |
| tar pax (long names, non-ASCII, oversized fields) | yes | yes, when needed |
| tar gnu long name/link (`L`/`K`) | yes | no (pax is written instead) |
| tar sparse (`S`) | error | not written |
| zip store (method 0) | yes | yes |
| zip deflate (method 8, miniz_oxide) | yes | yes |
| zip64 extra / EOCD | yes | auto when sizes/offsets require it |
| zip data descriptor | yes | not written by `zipCreate` (sizes known at finish) |
| zip encryption, bzip2, zstd, lzma | no | no |

## Differences from Go

- Sparse tar files throw `TarFormatError` instead of reconstructing holes.
- The writer emits ustar + pax, never GNU `L`/`K` long-name special files.
- `zipCreate` / `ZipWriter.end()` write local-header sizes rather than data
  descriptors, because the public API returns a complete buffer.
- Deflate bytes are not identical to Go `compress/flate`. Compare decompressed
  data, entry fields, and interoperability, never compressed archives byte-for-byte.
- DOS timestamps have two-second resolution when an extended timestamp extra
  field is absent. This package writes extra field `0x5455` when `modified` is set.
  A zero DOS date/time decodes as 1979-11-30 UTC, matching Go `archive/zip`
  `msDosTimeToTime` (so `modified` is still a `Date`, not omitted).
- Non-UTF-8 zip names keep the raw bytes on `rawName` and set `nonUtf8`. The
  `name` string is a lossy UTF-8 view and must not be treated as round-trippable.
- Filesystem helpers such as `extractTo` belong in `rustd-fs`, not this package.
- Zip `entry.mode` is Go `FileHeader.Mode()` (`io/fs.FileMode` bits), not the
  raw unix extra-attr word. FAT/NTFS/VFAT creators with empty attrs decode as
  `0o666` (and `ModeDir|0o666` when the name ends in `/`); unix creator with
  empty attrs is `0`. `zipCreate` / `ZipWriter` treat a provided `mode` like
  `FileHeader.SetMode`. There is no archive-level zip comment field.
- PAX `atime` / `ctime` stay on `entry.pax` as strings. They are not `Date`
  fields; the public TS shape only has `mtime` (issue #2). Invalid `atime` /
  `ctime` / `mtime` values still throw `TarFormatError`, matching Go `ErrHeader`.
- Sub-second `mtime` is written as PAX `mtime` so Go `ModTime` matches JS
  `Date.getTime()` at millisecond precision (`UnixMilli`). Nanoseconds beyond
  that are not a `Date` field. Integer-second `mtime` that fits the ustar octal
  field is stored only in the ustar header; PAX `mtime` is omitted.

## Errors

`TarFormatError` (`ERR_TAR_FORMAT`) and `ZipFormatError` (`ERR_ZIP_FORMAT`)
extend `ArchiveError` and carry `offset`. Messages follow Go phrasing
(`archive/tar: invalid tar header`, `archive/zip: not a valid zip file`).
Every proper prefix of a well-formed archive must throw one of these errors
(issue #2 §4.3). Listing is checked with GNU `tar -tf` and `unzip -Z -1`
(Linux stand-in for `bsdtar -tf` / `unzip -l`).

## Size

Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **557,568 bytes** (cap 2,000,000).

```text
$ ls -l packages/rustd-archive/*.node
-rwxrwxr-x 1 akrc akrc 557568 Sep 14 20:07 packages/rustd-archive/rustd-archive.linux-x64-gnu.node
```

Same-machine microbench, 200 files × 4 KiB, 20-run average: `tarCreate` **2.80 ms**,
Go `archive/tar` writer **2.62 ms**. Order-of-magnitude parity, not a product SLA.
