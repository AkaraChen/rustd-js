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
- `Bzip2Decompressor.write` pumps the decoder immediately. After the first
  decompressed byte the extra pending copy is dropped, so a large single stream
  does not keep the whole input. Small/concat streams still finish via
  `decompress_all` on `end()` because the vendor decoder over-reads past the
  member footer (no leftover `BZh`). `LzwDecompressor.write` decodes complete
  codes immediately and keeps only leftover bits (`nBits < width`) across
  chunks, matching Go `readLSB`/`readMSB`.
- `read()` always copies into a fresh `Uint8Array`. Go fills a caller buffer.
- Error classes are thrown (not `(value, error)`). `Bzip2FormatError` keeps the
  `bzip2 data invalid: …` prefix for structural failures (`bad magic value`,
  `bad magic value found`, `block checksum mismatch`, `file checksum mismatch`).
  Truncated bzip2 and LZW streams match Go's `io.ReadAll` text `unexpected EOF`
  with no prefix. Go's bare `EOF` is normalized to `unexpected EOF`. Corrupt LZW
  codes use Go's `lzw: invalid code`. One full-length bzip2 byte-flip can report
  `unexpected EOF` where Go says `insufficient selector indices for number of
  symbols` (Huffman bitstream vs selector list). Stream footer CRC is checked
  (upstream `bzip2-rs` left that TODO).
- LZW early-change timing follows Go fixtures, not GIF/TIFF folklore.

## Support matrix

`order` ∈ {`lsb`, `msb`} × `litWidth` ∈ {2,3,4,5,6,7,8}. Input bytes must be
`< 1<<litWidth`.

## Size

Local Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **440,368 bytes** (issue cap 1.5 MB).

```text
$ ls -l packages/rustd-compress/*.node
-rwxrwxr-x 1 akrc akrc 440368 Sep 14 18:26 packages/rustd-compress/rustd-compress.linux-x64-gnu.node
```
