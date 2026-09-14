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

export type Asn1Schema =
  | { kind: 'bool' }
  | { kind: 'int' }
  | { kind: 'bigint' }
  | { kind: 'bitstring' }
  | { kind: 'octetstring' }
  | { kind: 'oid' }
  | { kind: 'null' }
  | { kind: 'enumerated' }
  | { kind: 'utf8' }
  | { kind: 'ia5' }
  | { kind: 'printable' }
  | { kind: 'numeric' }
  | { kind: 'bmp' }
  | { kind: 'utctime' }
  | { kind: 'generalizedtime' }
  | { kind: 'raw' }
  | { kind: 'optional'; inner: Asn1Schema }
  | { kind: 'explicit'; tag: number; inner: Asn1Schema; class?: number }
  | { kind: 'implicit'; tag: number; inner: Asn1Schema; class?: number }
  | { kind: 'sequence'; fields: Array<{ name?: string; schema: Asn1Schema; optional?: boolean }> }
  | { kind: 'set'; fields: Array<{ name?: string; schema: Asn1Schema; optional?: boolean }> }
  | { kind: 'sequenceof'; inner: Asn1Schema }
  | { kind: 'setof'; inner: Asn1Schema };

export interface Asn1RawValue {
  class: number;
  tag: number;
  isCompound: boolean;
  bytes: Uint8Array;
  fullBytes: Uint8Array;
}

export interface Asn1BitString {
  bytes: Uint8Array;
  bitLength: number;
}

export class Asn1SyntaxError extends Error {
  constructor(message: string, options?: ErrorOptions);
  readonly code: 'ASN1_SYNTAX';
}

export class Asn1StructuralError extends Error {
  constructor(message: string, options?: ErrorOptions);
  readonly code: 'ASN1_STRUCTURAL';
}

export function asn1Marshal(value: unknown, schema: Asn1Schema, params?: string): Uint8Array;
export function asn1Unmarshal<T = unknown>(
  input: Uint8Array,
  schema: Asn1Schema,
  params?: string,
): { value: T; rest: Uint8Array };

export type XmlNodeType = 'start' | 'end' | 'chardata' | 'comment' | 'procinst' | 'directive';

export interface XmlName {
  space: string;
  local: string;
}

export interface XmlAttr {
  name: XmlName;
  value: string;
}

export interface XmlToken {
  type: XmlNodeType;
  name?: XmlName;
  attr?: XmlAttr[];
  text?: string;
  target?: string;
  inst?: Uint8Array;
}

export interface XmlDecoderOptions {
  strict?: boolean;
  autoClose?: string[];
  entity?: Record<string, string>;
  defaultSpace?: string;
  charsetReader?: (charset: string, input: Uint8Array) => Uint8Array;
}

export interface XmlSchema {
  name: string;
  tag?: string;
  path?: string;
  kind: 'element' | 'chardata' | 'attr' | 'comment' | 'any';
  type?: 'string' | 'int' | 'uint' | 'float' | 'bool' | 'bytes' | 'time';
  children?: XmlSchema[];
  marshaler?: boolean;
  omitempty?: boolean;
}

export class XmlDecoder {
  constructor(input: Uint8Array | string, opts?: XmlDecoderOptions);
  token(): XmlToken | null;
  rawToken(): XmlToken | null;
  decode(schema: XmlSchema, opts?: { start?: XmlToken }): unknown;
  skip(): void;
  inputOffset(): number;
  inputPos(): [line: number, column: number];
}

export class XmlEncoder {
  constructor(opts?: { indent?: string | { prefix: string; indent: string } });
  encodeToken(token: XmlToken): void;
  encode(value: unknown, schema: XmlSchema): void;
  flush(): void;
  bytes(): Uint8Array;
}

export function xmlMarshal(value: unknown, schema: XmlSchema): Uint8Array;
export function xmlMarshalIndent(value: unknown, schema: XmlSchema, prefix: string, indent: string): Uint8Array;
export function xmlUnmarshal<T = unknown>(input: Uint8Array | string, schema: XmlSchema): T;
export function xmlEscape(text: Uint8Array): Uint8Array;
export const XML_HEADER: string;
export const HTML_ENTITY: Readonly<Record<string, string>>;
export const HTML_AUTO_CLOSE: readonly string[];
export function getHtmlEntity(): Record<string, string>;
export function getHtmlAutoClose(): string[];

export class XmlSyntaxError extends Error {
  constructor(message: string, line: number, options?: ErrorOptions);
  readonly code: 'XML_SYNTAX';
  readonly line: number;
}

export class XmlUnsupportedTypeError extends Error {
  constructor(message: string, typeName: string, options?: ErrorOptions);
  readonly code: 'XML_UNSUPPORTED';
  readonly typeName: string;
}
