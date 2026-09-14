# rustd-compress

Synchronous Rust + Node-API port of Go `compress/bzip2` (decompress only) and
`compress/lzw`. Runtime Node >=20; no JavaScript runtime dependencies and no
`node:zlib` backend.

```js
import { bzip2Decompress, lzwCompress, lzwDecompress } from 'rustd-compress';

const plain = bzip2Decompress(bzBytes);
const packed = lzwCompress(plain, { order: 'lsb', litWidth: 8 });
const roundtrip = lzwDecompress(packed, { order: 'lsb', litWidth: 8 });
```

Streaming classes feed bounded compressed input (`chunkSize` default 1 MiB) and
return newly allocated `Uint8Array` slices from `read()`. There is no `close()`:
the native objects do not hold file descriptors or borrowed JS memory. `reset()`
clears codec state.

## Differences from Go

- `lzw.NewReader` / `NewWriter` delay `litWidth` range errors until the first
  `Read`/`Write`. This package throws `LzwConfigError` immediately with Go's
  `lzw: litWidth %d out of range` text.
- Unknown `order` values throw `LzwConfigError` with `lzw: unknown order`.
- Go has no bzip2 compressor; this package does not add one.
- Go may over-read a non-`io.ByteReader` source. Chunked JS writes do not.
- `read()` always copies into a fresh `Uint8Array`. Go fills a caller buffer.
- Error classes are thrown (not `(value, error)`). `Bzip2FormatError` keeps the
  `bzip2 data invalid: …` prefix. Exact Go `StructuralError` wording is matched
  when the decoder names the same failure; truncated streams may surface
  `unexpected EOF` instead of Go's `EOF`.
- LZW early-change timing follows Go fixtures, not GIF/TIFF folklore.

## Support matrix

`order` ∈ {`lsb`, `msb`} × `litWidth` ∈ {2,3,4,5,6,7,8}. Input bytes must be
`< 1<<litWidth`.

## Size

Local Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **447,840 bytes** (issue cap 1.5 MB).

```text
$ ls -l packages/rustd-compress/*.node
-rwxrwxr-x 1 akrc akrc 447840 Sep 14 15:44 packages/rustd-compress/rustd-compress.linux-x64-gnu.node
```
