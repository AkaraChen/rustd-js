# rustd-mime

Go `mime`, `mime/quotedprintable`, and `mime/multipart` (Writer WriteField / CreateFormField / CreateFormFile / CreatePart, Reader NextPart / NextRawPart including 1-byte and mid-boundary `write`, Reader ReadForm part-count) for Node via napi-rs.

This slice implements media types, the extension table, RFC 2047 encoded-words, quoted-printable, `MIMEHeader` (`Record<string, string[]>` + `canonicalMIMEHeaderKey` / Get/Set/Add/Del/Values), `MultipartWriter.writeField` / `createFormField` / `createFormFile` / `createPart`, `fileContentDisposition`, and `MultipartReader.nextPart` / `nextRawPart` / `readForm`. The same complete body fed whole, one byte at a time, or split inside `--boundary` with seed `0x4d494d45` yields the same part sequence (issue #9 §4.3). `nextPart` returns `null` until a complete part is buffered. Empty boundary and a header line without a colon throw the same `MultipartError` strings as Go. A truncated body (missing closer) stays at `null` rather than Go's `unexpected EOF`. Reader `nextPart` accepts a >70-character boundary (RFC 2046 / Go `SetBoundary` cap applies only to Writer). LF-only part headers match Go; a header block without a blank CRLF is the same missing-colon error. A part with no `Content-Disposition` is still returned (`formName`/`fileName` empty), matching Go `NextPart`. `nextPart` of 1000 and 1001 parts both succeed, matching Go 1.24 (`NextPart` has no part-count cap; `GODEBUG=multipartmaxparts` applies to `ReadForm` only). `readForm` of 1000 parts succeeds vs Go; 1001 is `MessageTooLargeError` (`multipart: message too large`). `maxParts` matches `GODEBUG=multipartmaxparts`. `nextPart` matches Go's quoted-printable CTE auto-decode. `rustd-net` is out of scope; this is the single `Part.header` type (issue #9). File spill and maxMemory accounting stay later.

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

Checkpoint 12: `MultipartReader.nextPart` of a complete one-part body matches Go `multipart.NewReader` (`FormName` / `FileName` / `Header` / body) for Go `Writer` and native `writeField` bytes. `write(chunk)` buffers; 1-byte interleaved feed, `nextRawPart`, `CreateFormFile`, and ReadForm limits are not in this slice.

Checkpoint 13: `nextPart` of a complete multi-field body (`WriteField` / `CreateFormField` mix, empty field, quoted name) matches Go `NewReader`.

Checkpoint 14: `nextPart` auto-decodes `Content-Transfer-Encoding: quoted-printable` (case-insensitive) and hides that header, matching Go `NextPart`. `nextRawPart` keeps the CTE and the encoded body, matching Go `NextRawPart`. 1-byte feed, `CreateFormFile`, `CreatePart`, and ReadForm limits stay later. Base64 CTE is out of scope (`rustd-encoding`).

Checkpoint 15: `MultipartWriter.createFormFile` matches Go `CreateFormFile` bytes (`Content-Disposition` + `Content-Type: application/octet-stream`). `fileContentDisposition` matches the `Content-Disposition` value Go `CreateFormFile` emits (Go 1.25 helper; Go 1.24 inlines the same format). `CreatePart`, 1-byte feed, and ReadForm stay later.

Checkpoint 16: `MultipartWriter.createPart(header)` matches Go `CreatePart` (keys sorted, values written as given, no re-canonicalization). `MIMEHeader` from this package (`mimeHeaderSet` / `Add`) is the header type. 1-byte feed and ReadForm stay later.

Checkpoint 17: the same complete multipart body, written one byte at a time with `nextPart` / `nextRawPart` after each byte, matches whole-body `write` then `nextPart` (headers, formName/fileName, body). Incomplete input returns `null`, not `unexpected EOF`. Random mid-boundary splits and ReadForm limits stay later.

Checkpoint 18: the same complete body, split inside each `--boundary` token with mulberry32 seed `0x4d494d45`, matches whole-body and 1-byte `nextPart` / `nextRawPart`. A write that ends inside the opening delimiter returns `null` until the rest arrives. ReadForm limits stay later.

Checkpoint 19: `nextPart` of a part with 10000 headers succeeds vs Go; 10001 is `MessageTooLargeError` (`multipart: message too large`). `maxHeadersPerPart` matches `GODEBUG=multipartmaxheaders`. ReadForm and part-count stay later.

Checkpoint 20: `nextPart` malformed bodies vs Go (issue #9 §4.4). Empty boundary is `multipart: boundary is empty`. A header line without a colon is `malformed MIME header: missing colon: "NotAHeader"` (Go `textproto`, CRLF stripped before `%q`). Missing closer / truncated part (Go `TestMultipartTruncated`) stays `null` here; Go `NextPart`+`Read` is `unexpected EOF`. 1-byte feed of the missing-colon body throws the same string. ReadForm and part-count stay later.

Checkpoint 21: `nextPart` overlong boundary and part header without CRLF vs Go (issue #9 §4.4). A 70-character boundary parses; a 71-character boundary still parses on `NewReader`/`nextPart` (Go Writer `SetBoundary` / native `MultipartWriter` reject it with `mime: invalid boundary length`). LF-only part headers match Go. A header block with no blank CRLF before the body is `malformed MIME header: missing colon: "hello"`. A truncated header line with no newline stays `null` (Go `NextPart` is EOF). ReadForm and part-count stay later.

Checkpoint 22: `nextPart` missing `Content-Disposition` vs Go (issue #9 §4.4). The part is returned, not an error; `formName`/`fileName` are empty. Empty headers, Content-Type only, LF-only, mixed missing-then-present, empty CD value, and quoted-printable without CD match Go `NewReader`. Whole-body / 1-byte / mid-boundary feeds agree. ReadForm and part-count stay later.

Checkpoint 23: `nextPart` of 1000 parts and 1001 parts both succeed vs Go 1.24 (issue #9 §4.4). Go `NextPart` / `NextRawPart` do not cap part count; `GODEBUG=multipartmaxparts=3` still returns 4 parts on `NextPart`. The 1000-part cap is `ReadForm` only. ReadForm stays later.

Checkpoint 24: `readForm` of 1000 parts succeeds vs Go 1.24 `ReadForm`; 1001 is `MessageTooLargeError` (`multipart: message too large`). `maxParts` matches `GODEBUG=multipartmaxparts`. Empty `FormName` parts still count. File spill and maxMemory accounting stay later.

## Differences from Go

- **Incremental `write` is non-blocking.** Go `NextPart` reads from an `io.Reader` until a part or EOF. Here `nextPart` / `nextRawPart` return `null` when the current buffer does not yet hold a complete part (or the closing delimiter). A truncated body that never gets the rest of the bytes stays at `null` rather than `multipart: NextPart: unexpected EOF`. Whole-body, 1-byte, and seeded mid-boundary splits of the same complete body produce the same part sequence. `Part.header` is this package's `MIMEHeader` (`Record<string, string[]>` with canonical keys). `net/textproto` itself is not exported. `Part.close()` then `read()` throws (`multipart: part is closed`); Go `Part.Close` then `Read` returns EOF. `createPart` writes header keys as provided (Go `CreatePart`); `mimeHeaderSet` / `Add` canonicalize first.
- **QP CTE decode errors surface on `nextPart`**, because this slice slurps the part body. Go wraps `quotedprintable.Reader` and reports the error on `Part.Read`. Non-QP `Content-Transfer-Encoding` values (including `7bit` / `base64`) are left as-is.
- **`MultipartWriter.bytes()` is idempotent** (second call returns the same buffer). Go `Writer.Close` writes a second trailer if called twice.
- **`readForm` does not spill to temp files.** File parts stay in `FileHeader.content`. `maxMemory` is accepted but not yet applied (checkpoint 24 is part-count only). Over the part cap it throws `MessageTooLargeError`, matching Go.
- **Windows does not query the registry** for `TypeByExtension`. Unix still loads the same globs2 / mime.types paths as Go 1.24 (`/etc/httpd/conf/mime.types` included).
- Invalid UTF-8 inside RFC 2047 `utf-8` words becomes U+FFFD in JS strings. Go strings can hold arbitrary bytes.
- Other RFC 2047 charsets go through JS `TextDecoder` (issue #9), not `encoding_rs`.
- Python `quopri.encodestring` keeps a lone LF. Go/`quotedPrintableEncode` text mode emits CRLF for that input. Cross-decode still works: Python encode → native decode recovers LF; native text encode → Python decode yields CRLF.

## Size

Recorded after `napi build --platform --release` on linux-x64-gnu, Rust 1.97.1 (2026-09-14, checkpoint 24): **517,392 bytes** / 2,000,000.
