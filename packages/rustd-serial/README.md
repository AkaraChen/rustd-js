# rustd-serial

Synchronous Rust + Node-API port of Go `encoding/csv` (reader + writer).
PEM, ASN.1, and XML from issue #8 are not in this 0.1.0 slice.

Runtime Node >=20; no JavaScript runtime dependencies.

```js
import { CsvReader, CsvWriter } from 'rustd-serial';

const rows = new CsvReader(Buffer.from('a,b\n1,2\n'), { fieldsPerRecord: -1 }).readAll();
const w = new CsvWriter();
w.writeAll(rows);
const bytes = w.bytes();
```

`CsvReader` takes a complete `Uint8Array`. Incremental stream parsing is out of
scope until `rustd-io` lands. There is no `close()`: the native objects do not
hold file descriptors.

## Differences from Go

- `ReuseRecord` is not ported. Every `read()` / `readBytes()` returns a new
  array. Sharing backing storage would alias JS typed arrays across calls.
- `TrailingComma` remains unused, matching Go's deprecation.
- `read()` returns `string[]` and throws `CsvEncodingError` when a field is not
  valid UTF-8. Go strings may contain arbitrary bytes. Use `readBytes()` for
  the original field bytes (including the Go `BinaryBlobField` case).
- Errors are thrown, not `(record, error)`. `ErrFieldCount` still fills
  `startLine` / `line` / `column` like `ParseError`, but the partial record is
  not returned.
- Invalid comma/comment delimiters throw `TypeError` at construction (Go waits
  until the first `Read`/`Write`).
- `fieldPos` throws `RangeError` instead of panicking.

## Size

Local Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **367,488 bytes** (issue cap 2 MB).

```text
$ ls -l packages/rustd-serial/*.node
-rwxrwxr-x 1 akrc akrc 367488 Sep 14 16:03 packages/rustd-serial/rustd-serial.linux-x64-gnu.node
```
