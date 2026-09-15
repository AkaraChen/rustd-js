# rustd-gotool

**This is a degraded, optional package.** Prefer running Go's own `go/version`,
`go/scanner`, and `gofmt` for tools that already have a Go toolchain. Use this
binding only when a Node process must classify Go toolchain strings or
tokenize Go source without spawning `go`.

Checkpoint 24 of [issue #28](https://github.com/AkaraChen/rustd-js/issues/28):
`go/version`, `go/token`, `go/scanner`, `go/parser` / `ast.Fprint`,
`GoParseError` recovery, §4.8 edges, plus the `go/constant` **Int** slice
(`constMakeInt64` / `constToInt` / `constCompare` / `constSign` / `constBitLen`
/ `constBinaryOp` / `constUnaryOp` / `constShift` vs Go `MakeInt64` /
`Int64Val` / `Compare` / `Sign` / `BitLen` / `BinaryOp` including AND_NOT /
`UnaryOp` ADD/SUB/XOR / `Shift` SHL/SHR), Int/Float `constToString` /
`constFloat64Val` vs Go `StringVal` / `Float64Val`, Int/Float
`constCompare` vs Go `Compare` (`big.Rat.Cmp`, including mixed Int vs QUO
Float), Float (plus mixed Int/Float) `constBinaryOp` ADD/SUB/MUL/QUO vs
Go `BinaryOp` (`match` to `big.Rat`, then `makeRat`), Float
`constUnaryOp` ADD/SUB vs Go `UnaryOp` (identity / `big.Rat.Neg`; integer-valued
Float stays Float), `constMakeFromLiteral` for INT/FLOAT/CHAR/IMAG/STRING vs Go
`MakeFromLiteral` (underscores, 0x/0o/0b/legacy octal, hex floats, rune
literals via `strconv.UnquoteChar`, imag prefix via `makeFloatFromLiteral`,
string via `strconv.Unquote`; invalid → Unknown; CHAR is an Int; IMAG is
Complex `(0 + xi)`; STRING is a String), Bool `constMakeBool` /
`constBoolVal` / `constUnaryOp` NOT / `constBinaryOp` LAND/LOR vs Go
`MakeBool` / `BoolVal` / `UnaryOp` NOT / `BinaryOp` LAND/LOR (Unknown
propagates),
and Complex `constBinaryOp` ADD/SUB/MUL/QUO vs Go `BinaryOp` (`vtoc` then
the component formula; mixed Int/Float; `1i*1i` stays Complex `(-1 + 0i)`),
plus Complex `constUnaryOp` ADD/SUB vs Go `UnaryOp` (ADD is identity; SUB is
`makeComplex(-re, -im)`), Complex `constCompareOp` EQL/NEQ vs Go
`MakeBool(Compare)` (component EQL after `match`/`vtoc`; Unknown vs Complex
can be NEQ true), String `constCompareOp` EQL/NEQ/LSS/LEQ/GTR/GEQ vs Go
`MakeBool(Compare)` (byte-wise Go string `<`; Unknown vs String is false),
and Bool `constCompareOp` EQL/NEQ vs Go `MakeBool(Compare)` (Unknown vs Bool
is false; mixed Bool vs Int/Float/Complex throw).
`go/format` / `gofmt` and
`go/build/constraint` are **not** in this release. API is `0.x` and unstable.

```js
import {
  versionLang, FileSet, Scanner, TOKEN, SCAN_MODE,
  PARSE_MODE, parseFile, astFprint,
  constMakeInt64, constMakeBool, constMakeFromLiteral, constCompare, constCompareOp, constToInt, constToString, constFloat64Val, constBoolVal,
  constBinaryOp, constUnaryOp, constShift, TOKEN,
} from 'rustd-gotool';

versionLang('go1.21rc2'); // "go1.21"
constMakeInt64(-42n).kind; // "Int"
constMakeFromLiteral('0x10', TOKEN.INT, 0).toString(); // "16"
constMakeFromLiteral('1.5', TOKEN.FLOAT, 0).toString(); // "3/2"
constMakeFromLiteral("'a'", TOKEN.CHAR, 0).toString(); // "97"
constMakeFromLiteral('1i', TOKEN.IMAG, 0).toString(); // "(0 + 1i)"
constMakeFromLiteral('"foo"', TOKEN.STRING, 0).toString(); // '"foo"'
constMakeBool(true).toString(); // "true"
constBoolVal(constUnaryOp(TOKEN.NOT, constMakeBool(true), 0)); // [false, true]
constBinaryOp(TOKEN.LAND, constMakeBool(true), constMakeBool(false)).toString(); // "false"
constBinaryOp(TOKEN.MUL, constMakeFromLiteral('1i', TOKEN.IMAG, 0), constMakeFromLiteral('1i', TOKEN.IMAG, 0)).toString(); // "(-1 + 0i)"
constUnaryOp(TOKEN.SUB, constMakeFromLiteral('1i', TOKEN.IMAG, 0), 0).toString(); // "(0 + -1i)"
constCompareOp(constMakeFromLiteral('1i', TOKEN.IMAG, 0), TOKEN.EQL, constMakeFromLiteral('1i', TOKEN.IMAG, 0)).toString(); // "true"
constCompareOp(constMakeFromLiteral('"a"', TOKEN.STRING, 0), TOKEN.LSS, constMakeFromLiteral('"b"', TOKEN.STRING, 0)).toString(); // "true"
constCompareOp(constMakeBool(true), TOKEN.EQL, constMakeBool(false)).toString(); // "false"
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
  (and mixed Int/Float) ADD/SUB/MUL/QUO, plus Complex (and mixed Int/Float)
  ADD/SUB/MUL/QUO, plus Bool LAND/LOR.
  ADD/SUB/MUL/REM/AND/OR/XOR/AND_NOT of two Ints stay `Int` (arbitrary precision).
  Mixed Int+Float and Float+Float ADD/SUB/MUL/QUO stay `Float` even when the
  rat is an integer (`1/2+1/2` is Float `"1"`, matching Go `makeRat`).
  `token.QUO` matches Go: the result is `Float` (`big.Rat`); integer division
  is Go's `QUO_ASSIGN` and is not exported here.
  REM/AND/OR/XOR/AND_NOT on a Float or Complex throw (Go panics).
  Complex ADD/SUB/MUL/QUO match Go's component formula after `vtoc`
  (numeric → Complex with imag Int 0). The result stays Complex even when imag
  is 0 (`1i*1i` is Complex `(-1 + 0i)`). Component kinds are preserved
  (`Real(1i)` is Int 0). QUO by `0+0i` returns `Unknown` instead of panicking.
  Bool LAND/LOR with an Unknown operand is Unknown. Mixed Bool+Int LAND/LOR
  throw (Go `match` would silently duplicate the Bool operand; we reject).
  `constUnaryOp` is Int ADD/SUB/XOR plus Float ADD/SUB plus Complex ADD/SUB plus Bool NOT. XOR `prec` matches Go:
  `0` is unlimited two's complement; `prec > 0` keeps the low `prec` bits.
  Float ADD is identity; Float SUB is `big.Rat.Neg`. Integer-valued Float stays
  Float (`+(1/2+1/2)` is Float `"1"`). Complex ADD is identity; Complex SUB
  negates both components (`-1i` is `(0 + -1i)`). XOR on Float or Complex throws (Go panics).
  NOT on a non-Bool throws (Go panics). `constMakeBool` takes a JS boolean.
  `constBoolVal` is Go `BoolVal`: Bool is `[b, true]`; Unknown is `[false, true]`;
  other kinds panic in Go → `[false, false]`. `GoConstValue#toString` for Bool is
  `"true"`/`"false"`. `constCompare` stays numeric-only. `constCompareOp` is Go
  `MakeBool(Compare(x, op, y))` for EQL/NEQ on Int/Float/Complex/Bool/Unknown
  and EQL/NEQ/LSS/LEQ/GTR/GEQ on String.
  Complex uses component EQL after `match`/`vtoc` (numeric → imag Int 0;
  Unknown → `complexVal{unknown, 0}`, so Unknown vs Complex NEQ can be true).
  Unknown vs Unknown or vs non-Complex is false for both EQL and NEQ.
  String compare is Go's byte-wise string `<` on Unquote bytes (`"a" < "\xff"`).
  Unknown vs String or Bool is false for every op. Mixed String vs Int/Bool/Complex
  throw (Go `match` would duplicate String vs Int so EQL is always true; Bool
  panics; Complex `vtoc`-wraps). Mixed Bool vs Int/Float/Complex throw (Go
  `match` would duplicate the Bool so `true == 1` is true; vs Complex `vtoc`-wraps).
  Complex LSS/LEQ/GTR/GEQ and Bool vs Bool LSS throw
  (Go panics on Complex ordering and Bool LSS). `constSign` throws on Bool/String
  (Go panics: not numeric).
  `constShift` is Int SHL/SHR; `s` must be a non-negative bigint in
  `0..1000000` (JS mapping of Go's unbounded `uint` to avoid native OOM).
  `constToInt` is Go `Int64Val`: `[value, true]` when the Int fits in int64;
  otherwise `[low64-with-sign, false]` (Go's `big.Int.Int64` wrapping).
  `constToString` is Go `StringVal` with panic mapped to `ok=false`: Int/Float/Bool
  are `["", false]`; String is `[unquoted, true]`; Unknown is `["", true]`.
  Invalid UTF-8 StringVal bytes become U+FFFD in the JS string; identity is
  `GoConstValue#toString` (`strconv.Quote`). `constFloat64Val` is Go
  `Float64Val` (IEEE bits + exact flag; Unknown is `[0, false]`).
  `GoConstValue#toString` is decimal for Int and `ExactString` (`n` or
  `n/d`) for Float from QUO, not Go's 512-bit `String()` approximation.
  QUO/REM by zero returns `Unknown` instead of panicking. `constCompare` is
  Go `Compare` for Int/Float (`match` to `big.Rat` then `Cmp`): mixed Int vs
  Float is allowed; `2/4` equals `1/2`. Unknown still throws. `constBitLen`
  throws on non-Int. `constMakeFromLiteral` is INT/FLOAT/CHAR/IMAG/STRING
  (`prec` must be 0; other tokens throw). Invalid literals are Unknown, matching
  Go. CHAR uses `strconv.UnquoteChar` on `lit[1:n-1]` and ignores leftover tail
  (`'ab'` is Int 97). STRING uses `strconv.Unquote` (leftover is Unknown:
  `'ab'` as STRING is Unknown; `''` is the empty String). IMAG requires a trailing
  `i` and parses the prefix as a
  FLOAT (`08i` is Complex 8 because float `SetString` is decimal). Result is
  Complex with real Int 0; `constReal`/`constImag` match Go `Real`/`Imag`.
  `GoConstValue#toString` for IMAG is Go `ExactString` (`(0 + 3/2i)`);
  for STRING it is Go `ExactString` (`strconv.Quote`);
  for Bool it is `"true"`/`"false"`.
  `constCompare` on Complex throws (ordering is -1/0/1 and undefined);
  use `constCompareOp` for bool EQL/NEQ. `1e9999i` (512-bit `floatVal`
  ExactString) is not in this checkpoint, same as FLOAT.
  Large-component rats that Go promotes to 512-bit
  `floatVal` (`BitLen >= 4096`) are not in this checkpoint.
- No `go/types`, `go/importer`, `go/build`, `ParseDir`, or `gofmt`.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-15): **787,936 bytes**.

```text
$ ls -l packages/rustd-gotool/*.node
-rwxrwxr-x 1 akrc akrc 787936 Sep 15 08:30 packages/rustd-gotool/rustd-gotool.linux-x64-gnu.node
```
