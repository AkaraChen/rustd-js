/** Duck-typed encoding.TextMarshaler. gob/xml call this before default encoding. */
export interface TextMarshaler { toText(): string }
export interface TextUnmarshaler { fromText(s: string): void }
export interface BinaryMarshaler { toBinary(): Uint8Array }
export interface BinaryUnmarshaler { fromBinary(b: Uint8Array): void }
export interface TextAppender { appendText(dst: Uint8Array): Uint8Array }
export interface BinaryAppender { appendBinary(dst: Uint8Array): Uint8Array }

export function tryBinaryMarshaler(value: unknown): Uint8Array | undefined;
export function tryTextMarshaler(value: unknown): string | undefined;

export class EncodingError extends Error { readonly code: string }
export class CorruptInputError extends EncodingError { readonly byteIndex: number }
export class InvalidByteError extends EncodingError { readonly byte: number }
export class HexLengthError extends EncodingError {}
export class BufferTooShortError extends EncodingError {}
export class VarintOverflowError extends EncodingError {}
export class GobTypeError extends EncodingError { readonly typeName?: string }

export type GobType =
  | { kind: 'bool' } | { kind: 'int' | 'int8' | 'int16' | 'int32' | 'int64' }
  | { kind: 'uint' | 'uint8' | 'uint16' | 'uint32' | 'uint64' }
  | { kind: 'float32' | 'float64' } | { kind: 'complex64' | 'complex128' }
  | { kind: 'bytes' | 'string' }
  | { kind: 'array'; elem: GobType; len: number }
  | { kind: 'slice'; elem: GobType }
  | { kind: 'map'; key: GobType; elem: GobType }
  | { kind: 'struct'; name: string; fields: { name: string; type: GobType }[] }
  | { kind: 'interface'; name?: string }
  | { kind: 'gobEncoder'; name: string }
export class GobEncoder {
  constructor(opts?: { onChunk?: (chunk: Uint8Array) => void })
  encode(value: unknown, type: GobType): void
  finish(): Uint8Array
  reset(): void
}
export class GobDecoder {
  constructor(opts?: { maxTypeSize?: number | bigint })
  write(chunk: Uint8Array): void
  decode(type: GobType): unknown
  readType(): GobType | null
  reset(): void
}
export function gobRegisterName(name: string, type: GobType): void
export function gobEncode(value: unknown, type: GobType): Uint8Array
export function gobDecode(data: Uint8Array, type: GobType): unknown

export interface EncodingOptions { padding?: string | null; strict?: boolean }

export class Base64Encoding {
  static readonly Std: Base64Encoding;
  static readonly URL: Base64Encoding;
  static readonly RawStd: Base64Encoding;
  static readonly RawURL: Base64Encoding;
  constructor(alphabet: string, opts?: EncodingOptions);
  encode(src: Uint8Array): Uint8Array;
  encodeToString(src: Uint8Array): string;
  decode(src: Uint8Array | string): Uint8Array;
  decodeString(s: string): Uint8Array;
  appendEncode(dst: Uint8Array, src: Uint8Array): Uint8Array;
  appendDecode(dst: Uint8Array, src: Uint8Array): Uint8Array;
  encodedLen(n: number): number;
  decodedLen(n: number): number;
  withPadding(padding: string | null): Base64Encoding;
  strict(): Base64Encoding;
  readonly alphabet: string;
}

export class Base32Encoding {
  static readonly Std: Base32Encoding;
  static readonly Hex: Base32Encoding;
  static readonly RawStd: Base32Encoding;
  static readonly RawHex: Base32Encoding;
  constructor(alphabet: string, opts?: EncodingOptions);
  encode(src: Uint8Array): Uint8Array;
  encodeToString(src: Uint8Array): string;
  decode(src: Uint8Array | string): Uint8Array;
  decodeString(s: string): Uint8Array;
  appendEncode(dst: Uint8Array, src: Uint8Array): Uint8Array;
  appendDecode(dst: Uint8Array, src: Uint8Array): Uint8Array;
  encodedLen(n: number): number;
  decodedLen(n: number): number;
  withPadding(padding: string | null): Base32Encoding;
  readonly alphabet: string;
}

export function hexEncode(src: Uint8Array): string;
export function hexDecode(s: string): Uint8Array;
export function hexAppendEncode(dst: Uint8Array, src: Uint8Array): Uint8Array;
export function hexAppendDecode(dst: Uint8Array, src: Uint8Array): Uint8Array;
export function hexEncodedLen(n: number): number;
export function hexDecodedLen(n: number): number;
export function hexDump(data: Uint8Array): string;
export function hexDumper(onLine: (line: string) => void): { write(b: Uint8Array): void; end(): void };

export function ascii85Encode(src: Uint8Array): Uint8Array;
export function ascii85EncodeToString(src: Uint8Array): string;
export function ascii85Decode(src: Uint8Array | string, flush: boolean): Uint8Array;
export function ascii85MaxEncodedLen(n: number): number;

export type ByteOrder = 'le' | 'be' | 'native';
export type BinaryKind =
  | 'bool' | 'int8' | 'int16' | 'int32' | 'int64'
  | 'uint8' | 'uint16' | 'uint32' | 'uint64'
  | 'float32' | 'float64';
export type BinarySchema =
  | { kind: BinaryKind }
  | { kind: 'array'; elem: BinarySchema; len: number }
  | { kind: 'struct'; fields: readonly { name: string; type: BinarySchema }[] };

export function binaryReadUvarint(src: Uint8Array, offset?: number): { value: bigint; n: number };
export function binaryReadVarint(src: Uint8Array, offset?: number): { value: bigint; n: number };
export function binaryPutUvarint(dst: Uint8Array, value: bigint, offset?: number): number;
export function binaryPutVarint(dst: Uint8Array, value: bigint, offset?: number): number;
export function binaryAppendUvarint(dst: Uint8Array, value: bigint): Uint8Array;
export function binaryAppendVarint(dst: Uint8Array, value: bigint): Uint8Array;
export function binaryUvarint(value: bigint): Uint8Array;
export function binarySizeOf(schema: BinarySchema): number;
export function binaryEncode(schema: BinarySchema, value: unknown, order: ByteOrder): Uint8Array;
export function binaryDecode(schema: BinarySchema, src: Uint8Array, order: ByteOrder): { value: unknown; n: number };
export const MaxVarintLen16: 3;
export const MaxVarintLen32: 5;
export const MaxVarintLen64: 10;
