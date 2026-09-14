export type TarEntryType =
  | 'reg'
  | 'dir'
  | 'symlink'
  | 'hardlink'
  | 'char'
  | 'block'
  | 'fifo'
  | 'x-global-header'
  | 'x-header'
  | string;

export interface TarOptions {}
export interface ZipOptions {}

export interface TarEntryInput {
  name: string;
  type?: TarEntryType;
  data?: Uint8Array;
  size?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  mtime?: Date;
  linkname?: string;
  uname?: string;
  gname?: string;
  pax?: Record<string, string>;
}

export interface TarEntry {
  name: string;
  type: TarEntryType;
  size: number;
  mode: number;
  uid?: number;
  gid?: number;
  mtime?: Date;
  linkname?: string;
  uname?: string;
  gname?: string;
  pax?: Record<string, string>;
  typeflag?: string;
  data?: Uint8Array;
}

export interface ZipEntryInput {
  name: string;
  method?: 0 | 8;
  data?: Uint8Array;
  size?: number;
  modified?: Date;
  comment?: string;
  mode?: number;
  nonUtf8?: boolean;
  rawName?: Uint8Array;
}

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  size: number;
  compressedSize: number;
  crc32: number;
  modified?: Date;
  comment?: string;
  mode?: number;
  nonUtf8?: boolean;
  rawName?: Uint8Array;
  data?: Uint8Array;
}

export class ArchiveError extends Error { readonly code: string }
export class TarFormatError extends ArchiveError { readonly offset: number }
export class ZipFormatError extends ArchiveError { readonly offset: number }

export function tarCreate(entries: TarEntryInput[], opts?: TarOptions): Uint8Array;
export function tarExtract(buf: Uint8Array, opts?: TarOptions): TarEntry[];
export function zipCreate(entries: ZipEntryInput[], opts?: ZipOptions): Uint8Array;
export function zipExtract(buf: Uint8Array, opts?: ZipOptions): ZipEntry[];

export class TarWriter {
  constructor(opts?: TarOptions);
  writeHeader(entry: TarEntryInput): void;
  write(data: Uint8Array): void;
  end(): Uint8Array;
}
export class ZipWriter {
  constructor(opts?: ZipOptions);
  writeHeader(entry: ZipEntryInput): void;
  write(data: Uint8Array): void;
  end(): Uint8Array;
}
export class TarReader {
  constructor(opts?: TarOptions);
  write(chunk: Uint8Array): void;
  on(event: 'entry', listener: (entry: TarEntry) => void): this;
  end(): void;
}
export class ZipReader {
  constructor(opts?: ZipOptions);
  write(chunk: Uint8Array): void;
  on(event: 'entry', listener: (entry: ZipEntry) => void): this;
  end(): void;
}
