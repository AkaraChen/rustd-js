'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-regexsyntax';
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

class SyntaxError extends Error {
  constructor(message, code, expr, options) {
    super(message, options);
    this.name = 'SyntaxError';
    this.code = code;
    this.expr = expr;
  }
}

const OP = Object.freeze({
  NoMatch: 1,
  EmptyMatch: 2,
  Literal: 3,
  CharClass: 4,
  AnyCharNotNL: 5,
  AnyChar: 6,
  BeginLine: 7,
  EndLine: 8,
  BeginText: 9,
  EndText: 10,
  WordBoundary: 11,
  NoWordBoundary: 12,
  Capture: 13,
  Star: 14,
  Plus: 15,
  Quest: 16,
  Repeat: 17,
  Concat: 18,
  Alternate: 19,
});

const FLAGS = Object.freeze({
  FoldCase: binding.flagFoldCase(),
  Literal: binding.flagLiteral(),
  ClassNL: binding.flagClassNl(),
  DotNL: binding.flagDotNl(),
  OneLine: binding.flagOneLine(),
  NonGreedy: binding.flagNonGreedy(),
  PerlX: binding.flagPerlX(),
  UnicodeGroups: binding.flagUnicodeGroups(),
  WasDollar: binding.flagWasDollar(),
  Simple: binding.flagSimple(),
  MatchNL: binding.flagMatchNl(),
  Perl: binding.flagPerl(),
  POSIX: binding.flagPosix(),
});

const FLAG_NAMES = [
  ['FoldCase', FLAGS.FoldCase],
  ['Literal', FLAGS.Literal],
  ['ClassNL', FLAGS.ClassNL],
  ['DotNL', FLAGS.DotNL],
  ['OneLine', FLAGS.OneLine],
  ['NonGreedy', FLAGS.NonGreedy],
  ['PerlX', FLAGS.PerlX],
  ['UnicodeGroups', FLAGS.UnicodeGroups],
  ['WasDollar', FLAGS.WasDollar],
  ['Simple', FLAGS.Simple],
];

function flagsToString(flags) {
  if (typeof flags !== 'number' || !Number.isInteger(flags)) {
    throw new TypeError('regexsyntax: flags must be an integer');
  }
  return FLAG_NAMES.filter(([, bit]) => (flags & bit) === bit).map(([name]) => name).join('|') || 'POSIX';
}

function native(fn) {
  try {
    const out = fn();
    if (out instanceof Error) throw out;
    return out;
  } catch (cause) {
    const text = String(cause.message ?? cause);
    if (text.startsWith('SyntaxError:')) {
      const rest = text.slice('SyntaxError:'.length);
      const first = rest.indexOf(':');
      const code = first < 0 ? rest : rest.slice(0, first);
      const after = first < 0 ? '' : rest.slice(first + 1);
      const second = after.indexOf(':');
      const expr = second < 0 ? after : after.slice(0, second);
      const message = second < 0 ? text : after.slice(second + 1);
      throw new SyntaxError(message, code, expr, { cause });
    }
    throw cause;
  }
}

class SyntaxRegexp {
  constructor(row) {
    this._dump = row.dump;
    this._printed = row.printed;
    this._json = JSON.parse(row.json);
    this._maxCap = row.maxCap;
    this._capNames = row.capNames;
  }

  get op() { return this._json.op; }
  get flags() { return this._json.flags; }
  get sub() { return this._json.sub.map((node) => wrapNode(node)); }
  get sub0() { return this.sub; }
  get rune() { return this._json.rune.slice(); }
  get min() { return this._json.min; }
  get max() { return this._json.max; }
  get cap() { return this._json.cap; }
  get name() { return this._json.name; }

  toString() { return this._printed; }
  dump() { return this._dump; }
  toJson() { return structuredClone(this._json); }
  maxCap() { return this._maxCap; }
  capNames() { return this._capNames.slice(); }
  equal(other) {
    if (!(other instanceof SyntaxRegexp)) return false;
    return this._dump === other._dump && this._printed === other._printed;
  }
}

function wrapNode(json) {
  const fake = Object.create(SyntaxRegexp.prototype);
  fake._dump = '';
  fake._printed = '';
  fake._json = json;
  fake._maxCap = json.cap ?? 0;
  fake._capNames = [];
  return fake;
}

function syntaxParse(pattern, flags) {
  if (typeof pattern !== 'string') {
    throw new TypeError('regexsyntax: pattern must be a string');
  }
  if (typeof flags !== 'number' || !Number.isInteger(flags)) {
    throw new TypeError('regexsyntax: flags must be an integer');
  }
  return new SyntaxRegexp(native(() => binding.syntaxParse(pattern, flags >>> 0)));
}

module.exports = {
  OP,
  FLAGS,
  SyntaxError,
  SyntaxRegexp,
  syntaxParse,
  flagsToString,
};
