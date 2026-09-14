# rustd-regexsyntax

Synchronous Rust + Node-API port of Go `regexp/syntax` (parse + print).
Compile, Simplify, Unicode `\p` tables, and Go→JS translation are later
checkpoints (issue #29).

Runtime Node >=20; no JavaScript runtime dependencies.

```js
import { syntaxParse, FLAGS, OP } from 'rustd-regexsyntax';

const re = syntaxParse('a(b)*c', FLAGS.Perl);
re.dump();      // cat{lit{a}star{cap{lit{b}}}lit{c}}  (Go parse_test encoding)
re.toString();  // same rules as (*syntax.Regexp).String()
re.op === OP.Concat;
re.capNames();
```

`syntaxParse(pattern, flags)` requires an integer flag bitmask. `FLAGS.Perl`
matches Go `syntax.Perl`. `OP` values match Go's `Op` iota (NoMatch starts at 1).

## Differences from Go

- Unicode character classes (`\p{Han}`, `\pL`, `\P{...}`) are not in this
  checkpoint. They return `SyntaxError` with code `invalid character class range`,
  matching Go's unknown-name path until the generated Unicode tables land.
- `Simplify()`, `syntaxCompile()`, `Prog`, and `toJavaScriptRegExp()` are not
  exported yet.
- `OP` numbering follows Go (`NoMatch = 1`), not the 0-based sketch in issue #29.
- Nesting / compiled-size limits match Go (`maxHeight = 1000`, `maxSize` /
  `maxRunes` budgets).

## Size

Local Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **481,264 bytes** (issue cap 2.5 MB for this package).

```text
$ ls -l packages/rustd-regexsyntax/*.node
-rwxrwxr-x 1 akrc akrc 481264 Sep 14 18:29 packages/rustd-regexsyntax/rustd-regexsyntax.linux-x64-gnu.node
```
