# rustd-gotool

**This is a degraded, optional package.** Prefer running Go's own `go/version`,
`go/scanner`, and `gofmt` for tools that already have a Go toolchain. Use this
binding only when a Node process must classify Go toolchain strings or
tokenize Go source without spawning `go`.

Checkpoint 14 of [issue #28](https://github.com/AkaraChen/rustd-js/issues/28):
`go/version`, `go/token`, `go/scanner`, `go/parser` / `ast.Fprint`,
`GoParseError` recovery, §4.8 edges, plus the `go/constant` **Int** slice
(`constMakeInt64` / `constToInt` / `constCompare` / `constSign` / `constBitLen`
/ `constBinaryOp` / `constUnaryOp` / `constShift` vs Go `MakeInt64` /
`Int64Val` / `Compare` / `Sign` / `BitLen` / `BinaryOp` including AND_NOT /
`UnaryOp` ADD/SUB/XOR / `Shift` SHL/SHR), Int/Float `constToString` /
`constFloat64Val` vs Go `StringVal` / `Float64Val`, Int/Float
`constCompare` vs Go `Compare` (`big.Rat.Cmp`, including mixed Int vs QUO
Float), Float (plus mixed Int/Float) `constBinaryOp` ADD/SUB/MUL/QUO vs
Go `BinaryOp` (`match` to `big.Rat`, then `makeRat`), and Float
`constUnaryOp` ADD/SUB vs Go `UnaryOp` (identity / `big.Rat.Neg`; integer-valued
Float stays Float).
`go/format` / `gofmt`, Complex/`MakeFromLiteral`/Bool/String, and
`go/build/constraint` are **not** in this release. API is `0.x` and unstable.

```js
import {
  versionLang, FileSet, Scanner, TOKEN, SCAN_MODE,
  PARSE_MODE, parseFile, astFprint,
  constMakeInt64, constCompare, constToInt, constToString, constFloat64Val,
  constBinaryOp, constUnaryOp, constShift, TOKEN,
} from 'rustd-gotool';

versionLang('go1.21rc2'); // "go1.21"
constMakeInt64(-42n).kind; // "Int"
constCompare(constMakeInt64(1n), constMakeInt64(2n)); // -1
constCompare(constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(2n)), constMakeInt64(1n)); // -1
constToInt(constMakeInt64(1n)); // [1n, true]
constToString(constMakeInt64(1n)); // ["", false] — Int is not a Go string constant
constFloat64Val(constMakeInt64(1n)); // [1, true]
constBinaryOp(TOKEN.ADD, constMakeInt64(1n), constMakeInt64(2n)).toString(); // "3"
constBinaryOp(TOKEN.ADD, constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(2n)), constMakeInt64(1n)).toString(); // "3/2"
constUnaryOp(TOKEN.XOR, constMakeInt64(0n), 8).toString(); // "255"
constUnaryOp(TOKEN.SUB, constBinaryOp(TOKEN.QUO, constMakeInt64(1n), constMakeInt64(2n)), 0).toString(); // "-1/2"
constShift(TOKEN.SHL, constMakeInt64(1n), 63n).toString(); // "9223372036854775808"

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
  `constBinaryOp` is Int ADD/SUB/MUL/QUO/REM/AND/OR/XOR/AND_NOT, plus Float
  (and mixed Int/Float) ADD/SUB/MUL/QUO.
  ADD/SUB/MUL/REM/AND/OR/XOR/AND_NOT of two Ints stay `Int` (arbitrary precision).
  Mixed Int+Float and Float+Float ADD/SUB/MUL/QUO stay `Float` even when the
  rat is an integer (`1/2+1/2` is Float `"1"`, matching Go `makeRat`).
  `token.QUO` matches Go: the result is `Float` (`big.Rat`); integer division
  is Go's `QUO_ASSIGN` and is not exported here.
  REM/AND/OR/XOR/AND_NOT on a Float throw (Go panics).
  `constUnaryOp` is Int ADD/SUB/XOR plus Float ADD/SUB. XOR `prec` matches Go:
  `0` is unlimited two's complement; `prec > 0` keeps the low `prec` bits.
  Float ADD is identity; Float SUB is `big.Rat.Neg`. Integer-valued Float stays
  Float (`+(1/2+1/2)` is Float `"1"`). XOR on Float throws (Go panics).
  `constShift` is Int SHL/SHR; `s` must be a non-negative bigint in
  `0..1000000` (JS mapping of Go's unbounded `uint` to avoid native OOM).
  `constToInt` is Go `Int64Val`: `[value, true]` when the Int fits in int64;
  otherwise `[low64-with-sign, false]` (Go's `big.Int.Int64` wrapping).
  `constToString` is Go `StringVal` with panic mapped to `ok=false`: Int/Float
  are `["", false]`; Unknown is `["", true]`. `constFloat64Val` is Go
  `Float64Val` (IEEE bits + exact flag; Unknown is `[0, false]`).
  `GoConstValue#toString` is decimal for Int and `ExactString` (`n` or
  `n/d`) for Float from QUO, not Go's 512-bit `String()` approximation.
  QUO/REM by zero returns `Unknown` instead of panicking. `constCompare` is
  Go `Compare` for Int/Float (`match` to `big.Rat` then `Cmp`): mixed Int vs
  Float is allowed; `2/4` equals `1/2`. Unknown still throws. `constBitLen`
  throws on non-Int. Complex, `MakeFromLiteral`, and Bool/String stay later.
  Large-component rats that Go promotes to 512-bit
  `floatVal` (`BitLen >= 4096`) are not in this checkpoint.
- No `go/types`, `go/importer`, `go/build`, `ParseDir`, or `gofmt`.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **752,864 bytes**.

```text
$ ls -l packages/rustd-gotool/*.node
-rwxrwxr-x 1 akrc akrc 752864 Sep 14 23:09 packages/rustd-gotool/rustd-gotool.linux-x64-gnu.node
```
