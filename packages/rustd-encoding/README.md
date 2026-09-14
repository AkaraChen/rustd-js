# rustd-encoding

Synchronous Rust + Node-API codecs for Go `encoding/base64`, `base32`, `hex`,
`ascii85`, `encoding/binary` varints plus fixed-width schema read/write, and
`encoding/gob` with explicit `GobType` schemas. Runtime Node >=20; no JavaScript
runtime dependencies. Native functions are private. This is
[issue #7](https://github.com/AkaraChen/rustd-js/issues/7) version `0.1.0`.

```js
import { Base64Encoding, hexEncode, binaryUvarint } from 'rustd-encoding';

Base64Encoding.Std.encodeToString(new Uint8Array([1, 2, 3]));
hexEncode(new Uint8Array([0xab, 0xcd])); // "abcd"
binaryUvarint(128n); // Uint8Array [0x80, 0x01]
```

## API

- `Base64Encoding` / `Base32Encoding`: Go `Encoding` objects. Static `Std` /
  `URL` / `RawStd` / `RawURL` (base64) and `Std` / `Hex` / `RawStd` / `RawHex`
  (base32). `withPadding(ch | null)` and base64 `strict()` return new instances.
  `decode` ignores CR/LF the way Go's `Decode` does.
- `hexEncode` / `hexDecode` / `hexDump` / `hexDumper`: lowercase hex;
  `hexDump` matches Go `hex.Dump` (hexdump -C lines without GNU's trailing
  address-only line).
- `ascii85Encode` / `ascii85Decode(src, flush)`: `flush` is required. Callers
  must strip `<~` / `~>`. Whitespace and controls are ignored on decode.
- `binaryUvarint` / `binaryReadUvarint` / `binaryPutUvarint` and signed
  counterparts: values are `bigint`. Overflow after 10 bytes throws
  `VarintOverflowError`.
- `binaryEncode` / `binaryDecode` / `binarySizeOf`: fixed-width `BinarySchema`
  only (scalars, arrays, structs). No padding between fields.
- `tryBinaryMarshaler` / `tryTextMarshaler`: duck-typed Go `encoding` interfaces.
- `GobEncoder` / `GobDecoder` / `gobEncode` / `gobDecode` / `gobRegisterName`:
  explicit `GobType` schema (no runtime inference). `int64`/`uint64` are
  `bigint`. Interface values are `{ $name, $type, $value }` and need
  `gobRegisterName`. `maxTypeSize` defaults to 1 GiB. A truncated stream
  throws `BufferTooShortError` at every proper prefix; a claimed message
  length above `maxTypeSize` throws `GobTypeError` without allocating.

## Differences from Go

- No `EncodeValue`/`DecodeValue` reflect API; schemas replace it.
- `nil` vs empty slices are indistinguishable on the wire (same as Go).
- Map pair order follows the JS `Map`/`Object` insertion order, not Go's
  randomized map walk, so map encodings may differ byte-for-byte from Go
  while remaining mutually decodable.
- `gobEncoder` kinds call `gobEncode()` or `toBinary()`; there is no
  `encoding.BinaryMarshaler` wire-type variant unless the schema says
  `gobEncoder`.
- `appendEncode` always returns a new `Uint8Array` (Go may reuse slice capacity).
- GNU `hexdump -C` prints a final address line; Go `hex.Dump` and this package
  do not.
- `binary.Read`/`Write` of Go `int`/`uint` architecture-sized kinds are not
  exposed; schema kinds are explicit widths.
- No constant-time / cryptographic claims.

## Performance (issue #7 §4.6)

Honest host numbers, Node v24.20.0, Linux x64 GNU, Rust 1.97.1. The §4.6 **1.2× vs Node `Buffer`** bar is **not** waived and **not** silently loosened. Native Std/URL/RawStd/RawURL encode and non-strict decode already write into a preallocated Node `Buffer` (private write-into; **no public `encodeInto`**). Node 24 `Buffer` base64 is in-process simdutf; the public napi `encode`/`decode` surface cannot match it.

| workload | rustd-encoding | baseline | ratio | §4.6 |
| --- | --- | --- | --- | --- |
| 1 MiB Std base64 encode+decode | 2.582 ms | Node `Buffer` 0.797 ms | **0.31×** (prior same host 1.083 / 0.454 = 0.42×) | miss; documented deviation |
| 1 MiB hex encode | 4.347 ms | handwritten JS loop 31.046 ms | **7.14×** | pass (≥3×) |
| 64 MiB Std encode/decode | no OOM (454 ms) | — | — | §4.3 pass |

Custom alphabets, custom padding, `strict()`, and CR/LF stay on the Go-compatible scalar path.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **627,528 bytes** (gob + `base64-simd` 0.8.0).

```text
$ ls -l packages/rustd-encoding/*.node
-rwxrwxr-x 1 akrc akrc 627528 Sep 14 17:51 packages/rustd-encoding/rustd-encoding.linux-x64-gnu.node
```

Std/URL/RawStd/RawURL encode and non-strict decode use `base64-simd` (runtime AVX2/AVX-512 detect). See **Performance** for §4.6 numbers. `npm pack` CJS/ESM load in a clean directory is covered by `test/pack.test.mjs`.
