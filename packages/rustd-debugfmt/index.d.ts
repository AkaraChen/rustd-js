export type BinaryKind = 'elf' | 'macho' | 'pe' | 'plan9';
export interface OpenOptions {
  base?: bigint;
  maxSectionBytes?: number | bigint;
}

export class DebugfmtError extends Error {
  readonly code: string;
  constructor(message?: string, options?: ErrorOptions);
}
export class BinaryFormatError extends DebugfmtError {
  readonly kind: string;
  readonly offset: bigint;
  constructor(message: string, kind: string, offset: bigint, options?: ErrorOptions);
}
export class UnsupportedFeatureError extends DebugfmtError {
  readonly feature: string;
  constructor(message: string, feature?: string, options?: ErrorOptions);
}
export class FileClosedError extends DebugfmtError {
  constructor(message?: string, options?: ErrorOptions);
}
export class BlockedRegionError extends DebugfmtError {
  constructor(message?: string, options?: ErrorOptions);
}

export function sniff(head: Uint8Array): BinaryKind | null;
export function open(path: string, opts?: OpenOptions): BinaryFile;
export function openBytes(buf: Uint8Array, opts?: OpenOptions): BinaryFile;
export function readBuildInfoFile(path: string): BuildInfo;
export function readBuildInfoBytes(b: Uint8Array): BuildInfo;

export interface BinaryFile {
  readonly kind: BinaryKind;
  readonly size: bigint;
  readonly isFat: boolean;
  readonly closed: boolean;
  arch(): string;
  endian(): 'little' | 'big';
  close(): void;
  sections(): SectionInfo[];
  section(name: string): SectionInfo | null;
  segments(): SegmentInfo[];
  symbols(): Symbol[];
  iterateSymbols(cb: (s: Symbol) => boolean | void): void;
  dynamicSymbols(): Symbol[];
  importedSymbols(): string[];
  importedLibraries(): string[];
  entryPoint(): bigint;
  hasDebugInfo(): boolean;
  buildInfo(): BuildInfo | null;
  dwarf(): DwarfReader | null;
  gosym(): GoSymTable | null;
  dynamicStrings(): string[];
  dynamicValue(tag: string): bigint | null;
}

export interface SectionInfo {
  name: string;
  type: string;
  flags: string[];
  addr: bigint;
  offset: bigint;
  size: bigint;
  link: number;
  info: number;
  addralign: bigint;
  entsize: bigint;
  compressed: boolean;
  data(): Uint8Array;
}

export interface SegmentInfo {
  name: string;
  type: string;
  offset: bigint;
  vaddr: bigint;
  paddr: bigint;
  filesz: bigint;
  memsz: bigint;
  prot: string[];
  align: bigint;
}

export interface Symbol {
  name: string;
  value: bigint;
  size: bigint;
  section: string | null;
  kind: 'text' | 'data' | 'bss' | 'rodata' | 'undefined' | 'file' | 'section' | 'unknown';
  global: boolean;
  external: boolean;
  version: string | null;
  library: string | null;
  go: { package: string; receiver: string; base: string; static: boolean } | null;
}

export interface BuildInfo {
  goVersion: string;
  path: string;
  main: Module;
  deps: Module[];
  settings: BuildSetting[];
}
export interface Module { path: string; version: string; sum: string; replace?: Module }
export interface BuildSetting { key: string; value: string }

export class DwarfReader {
  readonly version: 2 | 3 | 4 | 5;
  readonly addressSize: number;
  readonly byteOrder: 'little' | 'big';
  entries(): DwarfEntry[];
  iterateEntries(cb: (e: DwarfEntry) => boolean | void): void;
  entryAt(offset: bigint): DwarfEntry | null;
  seekPC(addr: bigint): DwarfEntry | null;
  lineReader(): LineReader;
  ranges(entry: DwarfEntry): { low: bigint; high: bigint }[];
  types(): TypeInfo[];
}
export interface DwarfEntry {
  tag: string;
  tagValue: number;
  offset: bigint;
  children: boolean;
  attrs: { attr: string; class: string; value: DwarfValue }[];
  type(): TypeInfo | null;
}
export type DwarfValue =
  | { kind: 'addr'; value: bigint }
  | { kind: 'u64'; value: bigint }
  | { kind: 'i64'; value: bigint }
  | { kind: 'str'; value: string }
  | { kind: 'block'; value: Uint8Array }
  | { kind: 'ref'; value: bigint }
  | { kind: 'bool'; value: boolean }
  | { kind: 'float'; value: number }
  | { kind: 'flag'; value: boolean };
export class LineReader {
  next(): LineEntry | null;
  seek(addr: bigint): void;
  seekPC(pc: bigint): string | null;
  files(): string[];
  reset(): void;
  tell(): bigint;
}
export interface LineEntry {
  address: bigint;
  file: string;
  line: number;
  column: number;
  isStmt: boolean;
  endSequence: boolean;
  prologueEnd: boolean;
  epilogueBegin: boolean;
  discriminator: number;
}
export interface TypeInfo {
  kind: 'basic' | 'struct' | 'union' | 'enum' | 'array' | 'ptr' | 'typedef' | 'func' | 'unsupported';
  name: string;
  byteSize: bigint | null;
  members?: { name: string; offset: bigint; typeName: string }[];
  elementType?: string;
  goKind?: string;
}
export class GoSymTable {
  pcToLine(pc: bigint): { file: string; line: number; fn: FuncInfo | null; inlineFrames: { file: string; line: number; fn: string }[] };
  lineToPC(file: string, line: number): bigint;
  pcToFunc(pc: bigint): FuncInfo | null;
  lookupFunc(name: string): FuncInfo | null;
  lookupSym(name: string): SymInfo | null;
  symByAddr(addr: bigint): SymInfo | null;
  funcs(): FuncInfo[];
}
export interface FuncInfo {
  entry: bigint;
  end: bigint;
  name: string;
  package: string;
  receiver: string;
  base: string;
  static: boolean;
}
export interface SymInfo {
  name: string;
  addr: bigint;
  kind: 'text' | 'data' | 'bss';
  goType: number;
  goVersion: number;
}

export class ElfFile {
  static open(path: string, opts?: OpenOptions): ElfFile;
  static openBytes(b: Uint8Array, opts?: OpenOptions): ElfFile;
  header(): {
    class: 32 | 64; data: string; osabi: string; abiVersion: number;
    machine: string; type: string; entry: bigint; version: number; flags: number;
  };
  class(): 32 | 64;
  osabi(): string;
  machine(): string;
  type(): string;
  progHeaders(): SegmentInfo[];
  dynamicTags(): Record<string, bigint>;
  close(): void;
  file(): BinaryFile;
}

export class MachOFile {
  static open(path: string, opts?: OpenOptions): MachOFile;
  header(): { magic: string; cpu: string; fileType: string; ncmds: number; flags: number };
  dylibs(): { path: string; compatVersion: string; currentVersion: string }[];
  close(): void;
  file(): BinaryFile;
}

export class PeFile {
  static open(path: string, opts?: OpenOptions): PeFile;
  static openBytes(b: Uint8Array, opts?: OpenOptions): PeFile;
  coffHeader(): { machine: string; numberOfSections: number; timeDateStamp: number; characteristics: number };
  close(): void;
  file(): BinaryFile;
}
