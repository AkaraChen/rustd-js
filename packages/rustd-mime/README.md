# rustd-mime

Go `mime`, `mime/quotedprintable`, and `mime/multipart.Writer` (WriteField / CreateFormField) for Node via napi-rs.

This slice implements media types, the extension table, RFC 2047 encoded-words, quoted-printable, `MIMEHeader` (`Record<string, string[]>` + `canonicalMIMEHeaderKey` / Get/Set/Add/Del/Values), and the first multipart writer slice: `MultipartWriter.writeField` / `createFormField` vs Go `multipart.NewReader`. `rustd-net` is out of scope; this is the single `Part.header` type (issue #9). Streaming `MultipartReader` and ReadForm limits are still later.

Checkpoint 2 expands Go fixtures to 200+ `ParseMediaType` cases (Go 1.24 `mediatype_test.go` plus generated parameter variants), Go 1.24 `FormatMediaType` / quoted-printable writer+reader / RFC 2047 `DecodeHeader` tables, TS→Go `formatMediaType` / quoted-printable verify, and 1-byte quoted-printable reads.

Checkpoint 3: `npm pack` of the JS tarball (no `.node` inside) plus a sibling platform tarball, clean-dir `require()` / `import()` load smoke, and recertified linux-x64-gnu `.node` ≤ 2 MB.

Checkpoint 4: `python3` `quopri` encode/decode vs `quotedPrintable*`, and Go `ParseMediaType` of native `formatMediaType` strings (issue #9 §4.2 non-multipart). Multipart still waits on `rustd-net`.

Checkpoint 5: `curl -H Content-Type` against a local Node HTTP server; the wire header equals the `-H` value, `parseMediaType` of that header matches the original, and Go `ParseMediaType` verifies the same strings (issue #9 §4.2 third-party). Multipart `curl -F` still waits on `rustd-net`.

Checkpoint 6: `loadSystemMimeTypes` custom `mime.types` / `globs2` (Go `loadMimeFile` / `loadMimeGlobsFile` rules, including `text/` charset default and first-weight-wins) plus unix default paths vs Go `TypeByExtension` / `ExtensionsByType`. Default `loadSystemMimeTypes()` matches Go 1.24 `initMimeUnix` (stop after the first readable globs2). Multipart still waits on `rustd-net`.

Checkpoint 7: `AddExtensionType` error strings vs Go 1.24 (`mime: extension %q missing leading dot` and `ParseMediaType` failures such as expected slash / expected token / no media type / invalid media parameter). Multipart still waits on `rustd-net`.

Checkpoint 8: `AddExtensionType` success mapping vs Go 1.24 — lowercase `text/` without charset stores `charset=utf-8`; `TEXT/PLAIN` is not rewritten; `text/plain; foo=bar` stores empty because `FormatMediaType` of the raw string fails; `TypeByExtension` after add (exact and lowercased) matches Go. Multipart still waits on `rustd-net`.

Checkpoint 9: `ExtensionsByType` after `AddExtensionType` keys off `ParseMediaType` justType. `TEXT/PLAIN` and the empty `FormatMediaType` rewrite of `text/plain; foo=bar` still register the lowercase extension under `text/plain`; lookups via `TEXT/PLAIN` and `text/plain; charset=utf-8` match Go 1.24. Multipart still waits on `MIMEHeader` (now in this package).

Checkpoint 10: `MIMEHeader` lives in this package (`rustd-net` cancelled). `canonicalMIMEHeaderKey` matches Go 1.24 `textproto.CanonicalMIMEHeaderKey`; `mimeHeaderGet` / `Values` / `Set` / `Add` / `Del` fold keys the same way. `Part.header` is that `Record<string, string[]>`. Multipart reader/writer still later.

Checkpoint 11: `MultipartWriter` `writeField` / `createFormField` emit Go `multipart.Writer` bytes (fixed boundary). Go `multipart.NewReader` reads one-part and multi-field bodies back (`FormName` + body). Streaming reader, `CreateFormFile`, `CreatePart`, and ReadForm limits are not in this slice. Boundary uses `getrandom` (30 bytes hex), not `Math.random()`.

## Differences from Go

- **No streaming multipart reader yet.** Writer `WriteField` / `CreateFormField` / `Close` (`bytes()`) are in. `Part.header` will be this package's `MIMEHeader` (`Record<string, string[]>` with canonical keys). `net/textproto` itself is not exported.
- **`MultipartWriter.bytes()` is idempotent** (second call returns the same buffer). Go `Writer.Close` writes a second trailer if called twice.
- **`ReadForm` will not spill to temp files** once multipart lands. Over `maxMemory` it will throw `MessageTooLargeError`.
- **Windows does not query the registry** for `TypeByExtension`. Unix still loads the same globs2 / mime.types paths as Go 1.24 (`/etc/httpd/conf/mime.types` included).
- Invalid UTF-8 inside RFC 2047 `utf-8` words becomes U+FFFD in JS strings. Go strings can hold arbitrary bytes.
- Other RFC 2047 charsets go through JS `TextDecoder` (issue #9), not `encoding_rs`.
- Python `quopri.encodestring` keeps a lone LF. Go/`quotedPrintableEncode` text mode emits CRLF for that input. Cross-decode still works: Python encode → native decode recovers LF; native text encode → Python decode yields CRLF.

## Size

Recorded after `napi build --platform --release` on linux-x64-gnu, Rust 1.97.1 (2026-09-14, checkpoint 11): **476,896 bytes** / 2,000,000.

```text
$ ls -l packages/rustd-mime/*.node
-rwxrwxr-x 1 akrc akrc 456776 Sep 14 18:01 packages/rustd-mime/rustd-mime.linux-x64-gnu.node
```
