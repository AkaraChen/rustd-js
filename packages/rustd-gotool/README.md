# rustd-gotool

**This is a degraded, optional package.** Prefer running Go's own `go/version`,
`go/scanner`, and `gofmt` for tools that already have a Go toolchain. Use this
binding only when a Node process must classify Go toolchain strings or
tokenize Go source without spawning `go`.

Checkpoint 6 of [issue #28](https://github.com/AkaraChen/rustd-js/issues/28):
`go/version`, `go/token`, `go/scanner`, `go/parser` / `ast.Fprint`,
`GoParseError` recovery, plus §4.8 edges (empty, comments-only, illegal UTF-8,
unclosed comment/string, nested parens, `_` type parameters, 2048-rune
identifier / 16KiB string line, `//go:build` syntax errors, nested generic
instantiation / `IndexListExpr`, interface-method type parameters).
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
- Parse errors throw `GoParseError` with `list` and `partialFile` (Go still
  returns a partial `*ast.File`; the AST is on the error, not discarded).
  Issue #28 §4.5 compares first-error position and error-count order of
  magnitude, plus top-level `decls.length`. Error *wording* is recorded when it
  differs (`test/parse-error-msg-diffs.json`; AllErrors same-offset permutation
  only in this checkpoint) and is not a pass/fail criterion.
- Nesting depth is capped at 1024 (`exceeded max nesting depth`) so a native
  thread cannot stack-overflow. Go's `go/parser` allows 1e5 because goroutine
  stacks grow. Inputs Go still accepts past 1024 levels are reported as parse
  errors here. `go/format` is still deferred.
- `//go:build` constraint syntax errors are **not** parse errors. Matching Go's
  `go/parser`, a malformed `//go:build` line stays a comment (`File.GoVersion`
  stays `""`). `constraint.Parse` belongs to the deferred
  `go/build/constraint` slice.
- `ast.Fprint` is the debug printer, not `gofmt`. `go/format` is not shipped.
- No `go/types`, `go/importer`, `go/build`, `ParseDir`, or `gofmt`.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **667,608 bytes**.

```text
$ ls -l packages/rustd-gotool/*.node
-rwxrwxr-x 1 akrc akrc 667608 Sep 14 18:28 packages/rustd-gotool/rustd-gotool.linux-x64-gnu.node
```
