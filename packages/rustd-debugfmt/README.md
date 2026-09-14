# rustd-debugfmt

Read ELF, Mach-O, PE, and Plan 9 binaries from Node. This 0.1.0 checkpoint
covers sniffing, mmap/`openBytes`, section/segment/symbol tables, and Go
`buildinfo`. DWARF and `gosym`/`pclntab` are not wired yet (`dwarf()` /
`gosym()` return `null`).

Addresses, offsets, and sizes are `bigint`. `open(path)` maps the file with
`memmap2` and requires an explicit `close()`.

## Differences from Go

- Compressed `.zdebug_*` / `SHF_COMPRESSED` sections are detected and marked
  `compressed: true`, but `data()` throws `UnsupportedFeatureError` until
  `rustd-compress` is a dependency.
- `dwarf()` and `gosym()` are out of this slice.
- `dynamicValue` always returns `null` in this slice.
- Fat Mach-O selects the current process architecture and errors if that slice
  is missing (it does not silently take the first arch).
- Section type names are Go `SHT_*` tokens when `object` exposes an ELF type;
  otherwise they fall back to `object::SectionKind`.
- Non-UTF-8 names use Unicode replacement rather than `bstr`.

## Format matrix (this slice)

| Format | sniff | open | sections | symbols | buildinfo | DWARF | gosym |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ELF | yes | yes | yes | yes | yes | no | no |
| Mach-O / fat | yes | yes | yes | yes | best-effort | no | no |
| PE | yes | yes | yes | yes | best-effort | no | no |
| Plan 9 a.out | yes | yes | yes | yes | scan | no | no |
| DWARF 2–5 | — | — | — | — | — | no | — |

## Size

Local Linux x64 GNU release (Rust 1.97.1, overflow-checks, strip):

```text
$ ls -l packages/rustd-debugfmt/*.node
-rwxrwxr-x 1 akrc akrc 530088 Sep 14 16:34 packages/rustd-debugfmt/rustd-debugfmt.linux-x64-gnu.node
```

530,088 bytes / 2,000,000 cap.
