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
- `gosym().pcToLine` returns the physical `pclntab` function in `fn` and the
  innermost source location in `file`/`line`. Inlined callees from
  `FUNCDATA_InlTree` / `PCDATA_InlTreeIndex` are listed innermost-first in
  `inlineFrames`.
- `FuncInfo.package` / `receiver` / `base` follow `debug/gosym.Sym`
  (`PackageName` / `ReceiverName` / `BaseName`, Go 1.20+ `go:`/`type:` rules).
  Methods keep the parentheses: `main.(*Box).Name` → receiver `(*Box)`.
  `static` is nm's lowercase type letter (`Type >= 'a'` / ELF local binding).
- `go tool objdump` TEXT names for assembly ABI wrappers append `.abi0`;
  pclntab uses the unsuffixed name at the same entry PC. objdump/nm also
  rewrite `·` (U+00B7) to `.`. `pcToLine` file/line still match at that PC.
- `LineReader.next()` walks every compile-unit sequence. An `EndSequence` row
  is a row, not EOF: the following `next()` is the next sequence (or `null` at
  the real end of the concatenated table). `seek`/`seekPC` search every CU,
  because DWARF addresses are not globally sorted.
- `DwarfEntry.type()` follows `DW_AT_specification`, then `DW_AT_abstract_origin`,
  then `DW_AT_type`, with a depth cap of 32. A cycle or deeper chain throws
  `BinaryFormatError` (`kind: dwarf_cycle`). `types()` still lists each DIE
  without chasing those refs.
- `dynamicValue` always returns `null` in this slice.
- Fat Mach-O selects the current process architecture and errors if that slice
  is missing (it does not silently take the first arch).
- Section type names are Go `SHT_*` tokens when `object` exposes an ELF type;
  otherwise they fall back to `object::SectionKind`.
- Non-UTF-8 names use Unicode replacement rather than `bstr`.
- ELF `symbols()[].kind` follows `go tool nm` / `cmd/internal/objfile`:
  `SHN_UNDEF`→`undefined`, `SHN_COMMON`→`bss`, `SHF_ALLOC|EXEC`→`text`,
  `SHF_ALLOC`→`rodata`, `SHF_ALLOC|WRITE`→`data` (including `.bss`; GNU `nm`
  would use `B`). `STT_FILE` is `file` (go tool nm prints `_`).

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
-rwxrwxr-x 1 akrc akrc 729056 Sep 14 20:04 packages/rustd-debugfmt/rustd-debugfmt.linux-x64-gnu.node
```

729,056 bytes / 2,000,000 cap.
