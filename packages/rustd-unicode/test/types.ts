import {
  isLetter,
  isTable,
  toUpper,
  toLower,
  toTitle,
  simpleFold,
  toCase,
  utf8DecodeRune,
  utf8EncodeRune,
  utf16Encode,
  UnknownTableError,
  type RangeTableName,
  type CaseKind,
} from '../index.js';

const letter: boolean = isLetter(0x41);
const name: RangeTableName = 'Latin';
const inLatin: boolean = isTable(name, 0x41);
const upper: number = toUpper(0x61);
const lower: number = toLower(0x41);
const title: number = toTitle(0x61);
const fold: number = simpleFold(0x41);
const kind: CaseKind = 'upper';
const cased: number = toCase(kind, 0x61);
const decoded: { r: number; size: number } = utf8DecodeRune(new Uint8Array([0x41]));
const encoded: Uint8Array = utf8EncodeRune(0x41);
const units: Uint16Array = utf16Encode(new Uint32Array([0x1f600]));
const err: UnknownTableError = new UnknownTableError('unknown');
void letter;
void inLatin;
void upper;
void lower;
void title;
void fold;
void cased;
void decoded;
void encoded;
void units;
void err;

// @ts-expect-error Runes are numbers, not strings.
isLetter('A');
// @ts-expect-error Table names are a closed union generated from Go.
isTable('latin', 0x41);
// @ts-expect-error Byte input is not a string.
utf8DecodeRune('A');
// @ts-expect-error Case mapping takes a code point, not a string.
toUpper('a');
// @ts-expect-error Case kind is a closed union.
toCase('up', 0x61);
