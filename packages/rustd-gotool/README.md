# rustd-gotool

**This is a degraded, optional package.** Prefer running Go's own `go/version`,
`go/scanner`, and `gofmt` for tools that already have a Go toolchain. Use this
binding only when a Node process must classify Go toolchain strings or
tokenize Go source without spawning `go`.

Checkpoint 9 of [issue #28](https://github.com/AkaraChen/rustd-js/issues/28):
`go/version`, `go/token`, `go/scanner`, `go/parser` / `ast.Fprint`,
`GoParseError` recovery, §4.8 edges, plus the `go/constant` **Int** slice
(`constMakeInt64` / `constToInt` / `constCompare` / `constSign` / `constBitLen`
/ `constBinaryOp` vs Go `MakeInt64` / `Int64Val` / `Compare` / `Sign` /
`BitLen` / `BinaryOp` for ADD/SUB/MUL/QUO/REM/AND/OR/XOR).
`go/format` / `gofmt`, Float/Complex/`UnaryOp`/`Shift`, and
`go/build/constraint` are **not** in this release. API is `0.x` and unstable.

```js
import {
  versionLang, FileSet, Scanner, TOKEN, SCAN_MODE,
  PARSE_MODE, parseFile, astFprint,
  constMakeInt64, constCompare, constToInt, constBinaryOp, TOKEN,
} from 'rustd-gotool';

versionLang('go1.21rc2'); // "go1.21"
constMakeInt64(-42n).kind; // "Int"
constCompare(constMakeInt64(1n), constMakeInt64(2n)); // -1
constToInt(constMakeInt64(1n)); // [1n, true]
constBinaryOp(TOKEN.ADD, constMakeInt64(1n), constMakeInt64(2n)).toString(); // "3"

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
- `GoConstValue` is an opaque handle (Go's `constant.Value` is an interface).
  `constMakeInt64` still requires a JS `bigint` that fits in Go `int64`.
  `constBinaryOp` is Int-only ADD/SUB/MUL/QUO/REM/AND/OR/XOR. ADD/SUB/MUL/REM/AND/OR/XOR
  stay `Int` (arbitrary precision). `token.QUO` matches Go: the result is `Float`
  (`big.Rat`); integer division is Go's `QUO_ASSIGN` and is not exported here.
  `constToInt` is Go `Int64Val`: `[value, true]` when the Int fits in int64;
  otherwise `[low64-with-sign, false]` (Go's `big.Int.Int64` wrapping). `GoConstValue#toString` is decimal for Int and `ExactString` (`n` or
  `n/d`) for Float from QUO, not Go's 512-bit `String()` approximation.
  QUO/REM by zero returns `Unknown` instead of panicking. `constCompare` /
  `constBitLen` throw on non-Int. SHL/SHR/AND_NOT, Float+Float, Complex,
  `MakeFromLiteral`, `UnaryOp`, and `Shift` stay later.
- No `go/types`, `go/importer`, `go/build`, `ParseDir`, or `gofmt`.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **733,072 bytes**.

```text
$ ls -l packages/rustd-gotool/*.node
-rwxrwxr-x 1 akrc akrc 733072 Sep 14 21:51 packages/rustd-gotool/rustd-gotool.linux-x64-gnu.node
```
