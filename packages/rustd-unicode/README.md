# rustd-unicode

Synchronous Rust + Node-API port of Go `unicode`, `unicode/utf8`, and
`unicode/utf16`. Table data is generated from Go 1.24.13
(`unicode.Version == "15.0.0"`). Runtime Node >=20; no JavaScript runtime
dependencies.

```js
import { isLetter, isTable, utf8DecodeRune, utf16Encode } from 'rustd-unicode';

isLetter(0x41);
isTable('Latin', 0x41);
utf8DecodeRune(Uint8Array.of(0xff)); // { r: 0xFFFD, size: 1 }
utf16Encode(new Uint32Array([0x1f600]));
```

Range tables stay on the native side. `isTable` / `tablesOf` take Go variable
names (`Latin`, `Nd`, `White_Space`, …). The name set is generated from Go and
must match `rangeTableNames()`. Unknown names throw `UnknownTableError` rather
than returning `false`.

`utf8Runes(bytes)` iterates `{ r, size, offset }` with `DecodeRune` semantics
and holds a reference to the input `Uint8Array` (do not mutate it during
iteration).

## Differences from Go

- Table arguments are strings, not `*RangeTable` pointers. Table bytes are not
  exported to JavaScript.
- `utf8EncodeRuneStrict` throws `InvalidRuneError`. Default `utf8EncodeRune`
  still writes U+FFFD for illegal runes, matching Go.
- `utf8Runes` and `utf8ValidString` are extra APIs. `utf8ValidString` is false
  for JS strings that contain unpaired surrogates.
- `toSpecialCase('dutch' | 'lithuanian', …)` uses the default `CaseRanges`
  mapping. Go 1.24 only ships `TurkishCase` and `AzeriCase` (the latter is an
  alias of Turkish).
- `XID_Start` / `XID_Continue` are not Go `unicode` exports in 1.24.13 and are
  not table names here.

## Differences from JavaScript

Simple case mapping is not `String.prototype.toUpperCase` / `toLowerCase`:

| Input | Go / rustd-unicode | JS |
| --- | --- | --- |
| `ß` (U+00DF) `toUpper` | `ß` | `SS` |
| `ı` (U+0131) `toUpper` | `I` | `I` |
| `İ` (U+0130) `toLower` | `i` | `i` + U+0307 |
| `ﬁ` (U+FB01) `toUpper` | `ﬁ` | `FI` |

`IsSpace` uses Unicode White_Space (so U+00A0 is a space), not category `Zs`
alone. `utf16Decode` replaces lone surrogates with U+FFFD; `codePointAt`
preserves them. `TextDecoder` replaces illegal UTF-8 by default; `utf8Valid`
reports false.

## Generate

Tables and fixtures come from `tools/gentables` on **Go 1.24.13**
(`unicode.Version == "15.0.0"`). Re-running the generator must not change
committed files:

```text
$ cd packages/rustd-unicode
$ GOWORK=off mise exec go@1.24.13 -- go run -C tools/gentables .
generated 245 range table names, unicode 15.0.0, go go1.24.13
$ git diff --exit-code -- src/generated.rs generated-names.d.ts test/fixtures
```

Same assertion as `pnpm generate:check` (from this package directory). Do not
regenerate with a different Go toolchain; `goVersion` is part of the fixture.

## Size

Local Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **511,224 bytes** (issue cap 2 MB).

```text
$ ls -l packages/rustd-unicode/*.node
-rwxrwxr-x 1 akrc akrc 511224 Sep 14 17:05 packages/rustd-unicode/rustd-unicode.linux-x64-gnu.node
```
