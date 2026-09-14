export interface CsvReaderOptions {
  comma?: string;
  comment?: string;
  fieldsPerRecord?: number;
  lazyQuotes?: boolean;
  trimLeadingSpace?: boolean;
}

export interface CsvWriterOptions {
  comma?: string;
  useCRLF?: boolean;
}

export interface CsvFieldPos {
  line: number;
  column: number;
}

export class CsvParseError extends Error {
  constructor(message: string, startLine: number, line: number, column: number, options?: ErrorOptions);
  readonly code: 'CSV_PARSE';
  readonly startLine: number;
  readonly line: number;
  readonly column: number;
}

export class CsvEncodingError extends Error {
  constructor(message: string, options?: ErrorOptions);
  readonly code: 'CSV_ENCODING';
}

export class CsvReader {
  constructor(input: Uint8Array, opts?: CsvReaderOptions);
  read(): string[] | null;
  readBytes(): Uint8Array[] | null;
  readAll(): string[][];
  fieldPos(field: number): CsvFieldPos;
  inputOffset(): number;
}

export class CsvWriter {
  constructor(opts?: CsvWriterOptions);
  write(record: Array<string | Uint8Array>): void;
  writeAll(records: Array<Array<string | Uint8Array>>): void;
  bytes(): Uint8Array;
  error(): Error | null;
}

export interface PemBlock {
  type: string;
  headers?: Record<string, string>;
  bytes: Uint8Array;
}

export interface PemDecodeResult {
  block: PemBlock;
  rest: Uint8Array;
}

export class PemEncodeError extends Error {
  constructor(message: string, options?: ErrorOptions);
  readonly code: 'PEM_ENCODE';
}

export function pemDecode(data: Uint8Array): PemDecodeResult | null;
export function pemDecodeAll(data: Uint8Array): PemBlock[];
export function pemEncode(block: PemBlock): Uint8Array;
