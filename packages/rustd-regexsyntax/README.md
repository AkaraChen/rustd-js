# rustd-regexsyntax

Synchronous Rust + Node-API port of Go `regexp/syntax` (parse, print, Simplify, Compile).
Unicode `\p` / `\P` tables are generated from Go 1.24.13
`unicode.Categories` / `unicode.Scripts` (Unicode 15.0.0). Matching engine
and Go→JS translation stay out of scope (issue #30). Parse fixtures cover
430 Go `syntax.Parse` cases (dump + String), including POSIX/Perl dual-mode
and 121 illegal samples. Reverse restring (issue #30 §4.2): `syntaxParse` →
`toString()` → Go `regexp.Compile` MatchString / FindString /
FindStringSubmatch vs the original pattern, on the 69 Perl-flag parse fixtures
plus a shared haystack corpus. Matching stays in Go; this package does not
ship an engine.

Runtime Node >=20; no JavaScript runtime dependencies.

```js
import { syntaxParse, syntaxCompile, emptyOpContext, isWordChar, FLAGS, OP, INST_OP, EMPTY_OP, ERROR_CODE } from 'rustd-regexsyntax';

const re = syntaxParse('a(b)*c', FLAGS.Perl);
re.dump();      // cat{lit{a}star{cap{lit{b}}}lit{c}}  (Go parse_test encoding)
re.toString();  // same rules as (*syntax.Regexp).String()
re.simplify().toString(); // (*syntax.Regexp).Simplify().String()
const prog = syntaxCompile('a+', FLAGS.Perl); // Go syntax.Compile after Parse
prog.inst[1].op === INST_OP.Rune1;
re.op === OP.Concat;
re.capNames();
emptyOpContext(-1, 97) & EMPTY_OP.BeginText; // Go syntax.EmptyOpContext
isWordChar(97) === true; // Go syntax.IsWordChar, ASCII [A-Za-z0-9_] only
```

`syntaxParse(pattern, flags)` requires an integer flag bitmask. `FLAGS.Perl`
matches Go `syntax.Perl`. `OP` values match Go's `Op` iota (NoMatch starts at 1).

## Differences from Go

- Unicode property tables (`unicode.Properties`, e.g. `\p{White_Space}`) are
  not generated in this checkpoint. Unknown names still return
  `invalid character class range`, matching Go.
- Unicode tables match **Go 1.24.13 / Unicode 15.0.0**, not a later Go 1.25
  snapshot.
- `syntaxCompile()` is Parse+Compile (same as Go `prog_test.go`), not a matching engine.
- `emptyOpContext` / `isWordChar` match Go `prog.go` (ASCII `\b`/`\B`); no matching engine.
- `OpRepeat` is not compiled: Go panics; we return an error. Call `simplify()` first.
- `toJavaScriptRegExp()` is not exported yet.
- `OP` numbering follows Go (`NoMatch = 1`), not the 0-based sketch in issue #29.
- `INST_OP` / `EMPTY_OP` numbering follows Go iota.
- Nesting / compiled-size limits match Go (`maxHeight = 1000`, `maxSize` /
  `maxRunes` budgets). `parse` uses an explicit stack for height so 1500-deep
  `((((…))))` returns `ERROR_CODE.NestingDepth` instead of aborting.
- `ERROR_CODE` strings match Go `syntax.ErrorCode`. Go 1.24.13 never produces
  `InternalError` or `InvalidCharClass` from `Parse`. `InvalidUTF8` is produced
  for invalid UTF-8 bytes in Go; JS `string` values are always valid UTF-8, so
  that code is exported but not reachable through `syntaxParse`.

## Parse throughput (issue #30 §4.5)

Same-machine 10k mixed `syntax.Parse` (2026-09-14, Node v24.20.0, Go 1.24.13, linux-x64, AMD EPYC 9645). One sequential pass after one warmup pass. Corpus: 70% cycled Go parse fixtures (invalid UTF-8 byte cases skipped), 30% generated Perl/POSIX patterns. Native numbers include napi-rs plus JS `SyntaxRegexp` tree materialization, not just the parser. Not an isolated benchmark; no hard line.

| runtime | ok / error | wall | parses / s |
| --- | ---: | ---: | ---: |
| rustd-regexsyntax `syntaxParse` | 8182 / 1818 | 763.677 ms | 13,095 |
| Go `regexp/syntax.Parse` | 8182 / 1818 | 59.795 ms | 167,238 |

Native is about **12.8× slower** than Go on this corpus (honest; the package value is Go-shaped trees, not parse speed). Reproduce: `nice -n 10 node packages/rustd-regexsyntax/test/bench-parse.mjs`.

## Size

Local Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **567,552 bytes** (issue cap 2 MB for this package).

```text
$ ls -l packages/rustd-regexsyntax/*.node
-rwxrwxr-x 1 akrc akrc 567552 Sep 14 19:37 packages/rustd-regexsyntax/rustd-regexsyntax.linux-x64-gnu.node
```
