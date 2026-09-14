export interface LzwOptions {
  order: 'lsb' | 'msb';
  litWidth: number;
}

export function bzip2Decompress(data: Uint8Array): Uint8Array;
export function lzwCompress(data: Uint8Array, opts: LzwOptions): Uint8Array;
export function lzwDecompress(data: Uint8Array, opts: LzwOptions): Uint8Array;

export class Bzip2Decompressor {
  constructor(opts?: { chunkSize?: number });
  write(chunk: Uint8Array): void;
  read(maxBytes?: number): Uint8Array;
  end(): void;
  reset(): void;
}

export class LzwDecompressor {
  constructor(opts: LzwOptions);
  write(chunk: Uint8Array): void;
  read(maxBytes?: number): Uint8Array;
  end(): void;
  reset(): void;
}

export class LzwCompressor {
  constructor(opts: LzwOptions);
  write(chunk: Uint8Array): void;
  finish(): Uint8Array;
}

export function bzip2DecompressStream(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
export function lzwCompressStream(
  chunks: AsyncIterable<Uint8Array>,
  opts: LzwOptions,
): AsyncIterable<Uint8Array>;
export function lzwDecompressStream(
  chunks: AsyncIterable<Uint8Array>,
  opts: LzwOptions,
): AsyncIterable<Uint8Array>;

export class Bzip2FormatError extends Error {
  constructor(message: string, offset: number, options?: ErrorOptions);
  readonly offset: number;
}
export class LzwFormatError extends Error {
  constructor(message: string, bitOffset: number, options?: ErrorOptions);
  readonly bitOffset: number;
}
export class LzwConfigError extends RangeError {}
