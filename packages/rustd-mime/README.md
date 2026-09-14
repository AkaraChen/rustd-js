# rustd-mime

Go `mime`, `mime/quotedprintable`, and (later) `mime/multipart` for Node via napi-rs.

This slice implements media types, the extension table, RFC 2047 encoded-words, and quoted-printable. Multipart waits on `rustd-net` `MIMEHeader` (issue #9 shape decision 1 / issue #10). Do not duplicate that type here.

Checkpoint 2 expands Go fixtures to 200+ `ParseMediaType` cases (Go 1.24 `mediatype_test.go` plus generated parameter variants), Go 1.24 `FormatMediaType` / quoted-printable writer+reader / RFC 2047 `DecodeHeader` tables, TS→Go `formatMediaType` / quoted-printable verify, and 1-byte quoted-printable reads.

## Differences from Go

- **No multipart yet.** `Part.header` is `net/textproto.MIMEHeader`. That type belongs to `rustd-net`. This package does not ship a private copy.
- **`ReadForm` will not spill to temp files** once multipart lands. Over `maxMemory` it will throw `MessageTooLargeError`.
- **Windows does not query the registry** for `TypeByExtension`. Unix still loads the same globs2 / mime.types paths as Go 1.24 (`/etc/httpd/conf/mime.types` included).
- Invalid UTF-8 inside RFC 2047 `utf-8` words becomes U+FFFD in JS strings. Go strings can hold arbitrary bytes.
- Other RFC 2047 charsets go through JS `TextDecoder` (issue #9), not `encoding_rs`.

## Size

Recorded after `napi build --platform --release` on linux-x64-gnu, Rust 1.97.1 (2026-09-14): **457,464 bytes** / 2,000,000.

```text
$ ls -l packages/rustd-mime/*.node
-rwxrwxr-x 1 akrc akrc 457464 Sep 14 16:23 packages/rustd-mime/rustd-mime.linux-x64-gnu.node
```
