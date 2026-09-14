import {
  isLetter,
  isTable,
  utf8DecodeRune,
  utf8EncodeRune,
  utf16Encode,
  UnknownTableError,
  type RangeTableName,
} from '../index.js';

const letter: boolean = isLetter(0x41);
const name: RangeTableName = 'Latin';
const inLatin: boolean = isTable(name, 0x41);
const decoded: { r: number; size: number } = utf8DecodeRune(new Uint8Array([0x41]));
const encoded: Uint8Array = utf8EncodeRune(0x41);
const units: Uint16Array = utf16Encode(new Uint32Array([0x1f600]));
const err: UnknownTableError = new UnknownTableError('unknown');
void letter;
void inLatin;
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
