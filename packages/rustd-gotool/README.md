# rustd-gotool

**This is a degraded, optional package.** Prefer running Go's own `go/version`,
`go/scanner`, and `gofmt` for tools that already have a Go toolchain. Use this
binding only when a Node process must classify Go toolchain strings or
tokenize Go source without spawning `go`.

Checkpoint 3 of [issue #28](https://github.com/AkaraChen/rustd-js/issues/28):
`go/version`, `go/token`, `go/scanner`, plus `go/parser` and `ast.Fprint`.
`go/format` / `gofmt`, `go/constant`, and `go/build/constraint` are **not**
in this release. API is `0.x` and unstable.

```js
import {
  versionLang, FileSet, Scanner, TOKEN, SCAN_MODE,
  PARSE_MODE, parseFile, astFprint,
} from 'rustd-gotool';

versionLang('go1.21rc2'); // "go1.21"

const src = new TextEncoder().encode('package p\n');
const fset = new FileSet();
const file = fset.addFile('p.go', fset.base(), src.length);
const sc = new Scanner(file, src, (pos, msg) => console.error(pos, msg), SCAN_MODE.ScanComments);
for (;;) {
  const { pos, tok, lit } = sc.scan();
  if (tok === TOKEN.EOF) break;
  console.log(file.position(pos), tok, lit);
}

const ast = parseFile(fset, 'p.go', src, PARSE_MODE.ParseComments | PARSE_MODE.SkipObjectResolution);
const chunks = [];
astFprint({ write: (c) => chunks.push(Buffer.from(c)) }, fset, ast);
```

## Differences from Go

- Strings for `go/version` must start with `go` (`"1.21"` is invalid).
- Custom suffixes after `-` are stripped (`go1.23.4-custom` ≡ `go1.23.4`).
- Starting with Go 1.21, `"go1.21"` is a language version and compares **less
  than** `"go1.21rc1"` and `"go1.21.0"`. `"go1.20"` ≡ `"go1.20.0"`.
- Invalid version strings, including `""`, compare equal to each other and
  less than any valid version.
- Non-string arguments throw `TypeError` (Go is statically typed).
- `token.Pos` is a JS `number` (Go source files cannot exceed 2^53 bytes).
  That is the opposite of `rustd-debugfmt`'s `bigint` offsets; do not unify them.
- `src = null` file reads belong to `rustd-fs` and throw if attempted later;
  this checkpoint requires a `Uint8Array` source.
- Identifier letters/digits use Go's `unicode.IsLetter` / `IsDigit` tables
  (not XID_Start / XID_Continue).
- `//line` relative paths are cleaned with slash-separated `path.Clean` rules
  (Unix `filepath` semantics).
- `parseFile` / `parseExpr` skip identifier resolution (`File.Scope`,
  `Ident.Obj`, `File.Unresolved` are always `null`), matching Go's
  recommended `SkipObjectResolution`.
- Parse errors throw `GoParseError` with `list` and `partialFile`.
- `ast.Fprint` is the debug printer, not `gofmt`. `go/format` is not shipped.
- No `go/types`, `go/importer`, `go/build`, `ParseDir`, or `gofmt`.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **667,672 bytes**.

```text
$ ls -l packages/rustd-gotool/*.node
-rwxrwxr-x 1 akrc akrc 667672 Sep 14 18:00 packages/rustd-gotool/rustd-gotool.linux-x64-gnu.node
```
