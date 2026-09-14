import type { RangeTableName } from './generated-names.d.ts';
export type { RangeTableName };

export const unicodeVersion: string;
export const maxRune: number;
export const replacementChar: number;
export const maxASCII: number;
export const maxLatin1: number;

export function isControl(r: number): boolean;
export function isDigit(r: number): boolean;
export function isGraphic(r: number): boolean;
export function isLetter(r: number): boolean;
export function isLower(r: number): boolean;
export function isMark(r: number): boolean;
export function isNumber(r: number): boolean;
export function isPrint(r: number): boolean;
export function isPunct(r: number): boolean;
export function isSpace(r: number): boolean;
export function isSymbol(r: number): boolean;
export function isTitle(r: number): boolean;
export function isUpper(r: number): boolean;

export function isTable(name: RangeTableName, r: number): boolean;
export function isOneOfTables(names: RangeTableName[], r: number): boolean;
export function tablesOf(r: number): RangeTableName[];
export function rangeTableNames(): RangeTableName[];

export type CaseKind = 'upper' | 'lower' | 'title';
export function toCase(kind: CaseKind, r: number): number;
export function toUpper(r: number): number;
export function toLower(r: number): number;
export function toTitle(r: number): number;
export function simpleFold(r: number): number;
export function toSpecialCase(name: 'turkish' | 'azeri' | 'dutch' | 'lithuanian', kind: CaseKind, r: number): number;

export const utf8RuneError: number;
export const utf8RuneSelf: number;
export const utf8MaxRune: number;
export const utf8UTFMax: number;

export function utf8Valid(bytes: Uint8Array): boolean;
export function utf8ValidString(s: string): boolean;
export function utf8ValidRune(r: number): boolean;
export function utf8RuneLen(r: number): number;
export function utf8RuneCount(bytes: Uint8Array): number;
export function utf8RuneStart(b: number): boolean;
export function utf8FullRune(bytes: Uint8Array, offset?: number): boolean;
export function utf8DecodeRune(bytes: Uint8Array, offset?: number): { r: number; size: number };
export function utf8DecodeLastRune(bytes: Uint8Array): { r: number; size: number };
export function utf8EncodeRune(r: number): Uint8Array;
export function utf8EncodeRuneStrict(r: number): Uint8Array;
export function utf8AppendRune(out: Uint8Array, r: number): Uint8Array;
export function utf8Runes(bytes: Uint8Array): IterableIterator<{ r: number; size: number; offset: number }>;

export function utf16Encode(codepoints: Uint32Array | Iterable<number>): Uint16Array;
export function utf16EncodeRune(r: number): { r1: number; r2: number };
export function utf16Decode(units: Uint16Array): Uint32Array;
export function utf16DecodeRune(r1: number, r2: number): number;
export function utf16IsSurrogate(r: number): boolean;
export function utf16RuneLen(r: number): number;
export function utf16AppendRune(out: Uint16Array, r: number): Uint16Array;

export class UnknownTableError extends Error {
  constructor(message: string, options?: ErrorOptions);
  readonly code: 'UNKNOWN_TABLE';
}
export class InvalidRuneError extends Error {
  constructor(message: string, options?: ErrorOptions);
  readonly code: 'INVALID_RUNE';
}
export class UnknownSpecialCaseError extends Error {
  constructor(message: string, options?: ErrorOptions);
  readonly code: 'UNKNOWN_SPECIAL_CASE';
}
