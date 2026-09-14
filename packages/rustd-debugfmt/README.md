# rustd-debugfmt

Read ELF, Mach-O, PE, and Plan 9 binaries from Node. This checkpoint covers
sniffing, mmap/`openBytes`, section/segment/symbol tables, Go `buildinfo`,
DWARF 2–5 DIE/line tables via `gimli`, and Go `pclntab` (`gosym()`).

Addresses, offsets, and sizes are `bigint`. `open(path)` maps the file with
`memmap2` and requires an explicit `close()`.

## Differences from Go

- Compressed `.zdebug_*` / `SHF_COMPRESSED` debug sections are inflated with
  `miniz_oxide` (zlib) when loading DWARF. `SectionInfo.data()` still throws
  `UnsupportedFeatureError` for compressed non-debug payloads until
  `rustd-compress` is a shared rust crate. Zstd-compressed DWARF is unsupported.
- `iterateEntries` currently walks a materialized DIE list (same pattern as
  `iterateSymbols`). A lazy gimli cursor is a follow-up if DIE counts demand it.
- `gosym().pcToLine` returns the outer `pclntab` frame; `inlineFrames` is empty
  until the inlined-tree decoder is added.
- `DwarfEntry.type()` is a stub (`null`); use `types()` for DIE-derived types.
- `dynamicValue` always returns `null` in this slice.
- Fat Mach-O selects the current process architecture and errors if that slice
  is missing (it does not silently take the first arch).
- Section type names are Go `SHT_*` tokens when `object` exposes an ELF type;
  otherwise they fall back to `object::SectionKind`.
- Non-UTF-8 names use Unicode replacement rather than `bstr`.

## Format matrix (this slice)

| Format | sniff | open | sections | symbols | buildinfo | DWARF | gosym |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ELF | yes | yes | yes | yes | yes | yes | yes |
| Mach-O / fat | yes | yes | yes | yes | best-effort | yes | yes |
| PE | yes | yes | yes | yes | best-effort | yes | yes |
| Plan 9 a.out | yes | yes | yes | yes | scan | no | no |
| DWARF 2–5 | — | — | — | — | — | yes | — |

## Size

Local Linux x64 GNU release (Rust 1.97.1, overflow-checks, strip):

```text
$ ls -l packages/rustd-debugfmt/*.node
-rwxrwxr-x 1 akrc akrc 708664 Sep 14 17:02 packages/rustd-debugfmt/rustd-debugfmt.linux-x64-gnu.node
```

708,664 bytes / 2,000,000 cap.
