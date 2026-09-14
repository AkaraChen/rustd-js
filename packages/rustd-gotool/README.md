# rustd-gotool

**This is a degraded, optional package.** Prefer running Go's own `go/version`,
`go/scanner`, and `gofmt` for tools that already have a Go toolchain. Use this
binding only when a Node process must classify Go toolchain strings (or, in
later checkpoints, tokenize/parse Go source) without spawning `go`.

Checkpoint 1 of [issue #28](https://github.com/AkaraChen/rustd-js/issues/28):
`go/version` only (`Compare` / `IsValid` / `Lang`). Scanner, parser, printer,
`go/constant`, and `go/build/constraint` are not in this release. API is `0.x`
and unstable.

```js
import { versionCompare, versionIsValid, versionLang } from 'rustd-gotool';

versionIsValid('go1.21rc2');          // true
versionLang('go1.21rc2');             // "go1.21"
versionCompare('go1.21', 'go1.21.0'); // -1  (language version < first release)
```

## Differences from Go

- Strings must start with `go` (`"1.21"` is invalid), matching `go/version`.
- Custom suffixes after `-` are stripped (`go1.23.4-custom` ≡ `go1.23.4`).
- Starting with Go 1.21, `"go1.21"` is a language version and compares **less
  than** `"go1.21rc1"` and `"go1.21.0"`. `"go1.20"` ≡ `"go1.20.0"`.
- Invalid strings, including `""`, compare equal to each other and less than
  any valid version.
- Non-string arguments throw `TypeError` (Go is statically typed).
- No `go/token`, `go/scanner`, `go/parser`, `go/types`, `go/importer`,
  `go/build`, `ParseDir`, or `gofmt`. `src = null` file reads belong to
  `rustd-fs` and are not implemented here.

`token.Pos` will be a JS `number` in a later checkpoint (Go source files cannot
exceed 2^53 bytes). That is the opposite of `rustd-debugfmt`'s `bigint` offsets;
do not unify them.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **343,656 bytes**.

```text
$ ls -l packages/rustd-gotool/*.node
-rwxrwxr-x 1 akrc akrc 343656 Sep 14 16:58 packages/rustd-gotool/rustd-gotool.linux-x64-gnu.node
```
