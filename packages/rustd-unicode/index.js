'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-unicode';
let platform = `${process.platform}-${process.arch}`;
if (process.platform === 'linux') {
  if (!process.report.getReport().header.glibcVersionRuntime) {
    throw new Error(`${name}: Linux musl is not supported`);
  }
  platform += '-gnu';
} else if (process.platform === 'win32') platform += '-msvc';
if (!['darwin-arm64', 'darwin-x64', 'linux-x64-gnu', 'linux-arm64-gnu', 'win32-x64-msvc'].includes(platform)) {
  throw new Error(`${name}: unsupported platform ${platform}`);
}
const local = join(__dirname, `${name}.${platform}.node`);
const binding = existsSync(local) ? require(local) : require(`${name}-${platform}`);

class UnknownTableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UnknownTableError';
    this.code = 'UNKNOWN_TABLE';
  }
}

class InvalidRuneError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'InvalidRuneError';
    this.code = 'INVALID_RUNE';
  }
}

class UnknownSpecialCaseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UnknownSpecialCaseError';
    this.code = 'UNKNOWN_SPECIAL_CASE';
  }
}

function native(fn) {
  try {
    return fn();
  } catch (cause) {
    const text = String(cause.message ?? cause);
    if (text.startsWith('UnknownTableError:')) {
      throw new UnknownTableError(`unknown range table ${text.slice('UnknownTableError:'.length)}`, { cause });
    }
    if (text.startsWith('InvalidRuneError:')) {
      throw new InvalidRuneError(`invalid rune ${text.slice('InvalidRuneError:'.length)}`, { cause });
    }
    if (text.startsWith('UnknownSpecialCaseError:')) {
      throw new UnknownSpecialCaseError(`unknown special case ${text.slice('UnknownSpecialCaseError:'.length)}`, { cause });
    }
    if (text.startsWith('UnknownCaseKindError:')) {
      throw new TypeError(`unknown case kind ${text.slice('UnknownCaseKindError:'.length)}`, { cause });
    }
    if (text.startsWith('RangeError:')) {
      throw new RangeError(text.slice('RangeError:'.length), { cause });
    }
    if (text.startsWith('TypeError:')) {
      throw new TypeError(text.slice('TypeError:'.length), { cause });
    }
    throw cause;
  }
}

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('unicode: expected Uint8Array');
  }
  return value;
}

function units16(value) {
  if (!(value instanceof Uint16Array)) {
    throw new TypeError('unicode: expected Uint16Array');
  }
  return value;
}

function* utf8Runes(input) {
  const data = bytes(input);
  let offset = 0;
  while (offset < data.length) {
    const { r, size } = native(() => binding.utf8DecodeRune(data, offset));
    yield { r, size, offset };
    offset += size === 0 ? 1 : size;
  }
}

function utf8ValidString(s) {
  if (typeof s !== 'string') {
    throw new TypeError('unicode: utf8ValidString expects a string');
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf16Encode(codepoints) {
  let arr;
  if (codepoints instanceof Uint32Array) {
    arr = codepoints;
  } else if (codepoints != null && typeof codepoints[Symbol.iterator] === 'function') {
    arr = Uint32Array.from(codepoints, (n) => {
      if (typeof n !== 'number' || !Number.isInteger(n)) {
        throw new TypeError('unicode: utf16Encode expects integer code points');
      }
      return n >>> 0;
    });
  } else {
    throw new TypeError('unicode: utf16Encode expects Uint32Array or Iterable<number>');
  }
  return binding.utf16Encode(arr);
}

module.exports = {
  unicodeVersion: binding.unicodeVersion(),
  maxRune: binding.maxRune ?? binding.MAX_RUNE ?? 0x10ffff,
  replacementChar: binding.replacementChar ?? binding.REPLACEMENT_CHAR ?? 0xfffd,
  maxASCII: binding.maxAscii ?? binding.MAX_ASCII ?? 0x7f,
  maxLatin1: binding.maxLatin1 ?? binding.MAX_LATIN1 ?? 0xff,
  utf8RuneError: binding.utf8RuneError ?? binding.UTF8_RUNE_ERROR ?? 0xfffd,
  utf8RuneSelf: binding.utf8RuneSelf ?? binding.UTF8_RUNE_SELF ?? 0x80,
  utf8MaxRune: binding.utf8MaxRune ?? binding.UTF8_MAX_RUNE ?? 0x10ffff,
  utf8UTFMax: binding.utf8UtfMax ?? binding.UTF8_UTF_MAX ?? 4,
  isControl: (r) => binding.isControl(r),
  isDigit: (r) => binding.isDigit(r),
  isGraphic: (r) => binding.isGraphic(r),
  isLetter: (r) => binding.isLetter(r),
  isLower: (r) => binding.isLower(r),
  isMark: (r) => binding.isMark(r),
  isNumber: (r) => binding.isNumber(r),
  isPrint: (r) => binding.isPrint(r),
  isPunct: (r) => binding.isPunct(r),
  isSpace: (r) => binding.isSpace(r),
  isSymbol: (r) => binding.isSymbol(r),
  isTitle: (r) => binding.isTitle(r),
  isUpper: (r) => binding.isUpper(r),
  isTable: (name, r) => native(() => binding.isTable(name, r)),
  isOneOfTables: (names, r) => native(() => binding.isOneOfTables(names, r)),
  tablesOf: (r) => binding.tablesOf(r),
  rangeTableNames: () => binding.rangeTableNames(),
  toCase: (kind, r) => native(() => binding.toCase(kind, r)),
  toUpper: (r) => binding.toUpper(r),
  toLower: (r) => binding.toLower(r),
  toTitle: (r) => binding.toTitle(r),
  simpleFold: (r) => binding.simpleFold(r),
  toSpecialCase: (name, kind, r) => native(() => binding.toSpecialCase(name, kind, r)),
  utf8Valid: (data) => binding.utf8Valid(bytes(data)),
  utf8ValidString,
  utf8ValidRune: (r) => binding.utf8ValidRune(r),
  utf8RuneLen: (r) => binding.utf8RuneLen(r),
  utf8RuneCount: (data) => binding.utf8RuneCount(bytes(data)),
  utf8RuneStart: (b) => native(() => binding.utf8RuneStart(b)),
  utf8FullRune: (data, offset) => native(() => binding.utf8FullRune(bytes(data), offset)),
  utf8DecodeRune: (data, offset) => native(() => binding.utf8DecodeRune(bytes(data), offset)),
  utf8DecodeLastRune: (data) => binding.utf8DecodeLastRune(bytes(data)),
  utf8EncodeRune: (r) => binding.utf8EncodeRune(r),
  utf8EncodeRuneStrict: (r) => native(() => binding.utf8EncodeRuneStrict(r)),
  utf8AppendRune: (out, r) => binding.utf8AppendRune(bytes(out), r),
  utf8Runes,
  utf16Encode,
  utf16EncodeRune: (r) => binding.utf16EncodeRune(r),
  utf16Decode: (u) => binding.utf16Decode(units16(u)),
  utf16DecodeRune: (r1, r2) => binding.utf16DecodeRune(r1, r2),
  utf16IsSurrogate: (r) => binding.utf16IsSurrogate(r),
  utf16RuneLen: (r) => binding.utf16RuneLen(r),
  utf16AppendRune: (out, r) => binding.utf16AppendRune(units16(out), r),
  firstIsTableMismatch: (name, lo, hi) => native(() => binding.firstIsTableMismatch(name, lo, hi)),
  firstCaseMismatch: (rows) => native(() => binding.firstCaseMismatch(rows)),
  caseFullChecksum: () => binding.caseFullChecksum(),
  UnknownTableError,
  InvalidRuneError,
  UnknownSpecialCaseError,
};
