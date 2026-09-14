import {
  sniff, open, openBytes, readBuildInfoFile, readBuildInfoBytes,
  ElfFile, BinaryFormatError, FileClosedError, BlockedRegionError,
  type BinaryFile, type Symbol, type BuildInfo,
} from '../index.js';

const kind = sniff(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
const file: BinaryFile = openBytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
const addr: bigint = file.entryPoint();
const symbols: Symbol[] = file.symbols();
const info: BuildInfo | null = file.buildInfo();
const elf: ElfFile = ElfFile.openBytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
const err: BinaryFormatError = new BinaryFormatError('bad', 'magic', 0n);
void [kind, addr, symbols, info, elf, err, FileClosedError, BlockedRegionError, readBuildInfoFile, readBuildInfoBytes, open];

// @ts-expect-error: sniff does not take a string
sniff('ELF');
// @ts-expect-error: addresses are bigint
const asNumber: number = file.size;
// @ts-expect-error: dwarf is null in this slice
file.dwarf().entries();
void asNumber;
