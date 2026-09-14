'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-gotool';
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
// Do not hide a broken local binary behind an optional-package fallback.
const binding = existsSync(local) ? require(local) : require(`${name}-${platform}`);

function versionString(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`gotool: ${label} must be a string`);
  }
  return value;
}

function versionCompare(x, y) {
  return binding.versionCompare(versionString(x, 'x'), versionString(y, 'y'));
}
function versionIsValid(x) {
  return binding.versionIsValid(versionString(x, 'x'));
}
function versionLang(x) {
  return binding.versionLang(versionString(x, 'x'));
}

function asBigInt(value, label) {
  if (typeof value !== 'bigint') {
    throw new TypeError(`gotool: ${label} must be a bigint`);
  }
  return value;
}

class GoConstValue {
  constructor(native) {
    this._n = native;
  }
  get kind() {
    return this._n.kind;
  }
  toString() {
    return binding.constString(this._n);
  }
}

function asConst(value, label) {
  if (!(value instanceof GoConstValue)) {
    throw new TypeError(`gotool: ${label} must be a GoConstValue`);
  }
  return value;
}

function constMakeInt64(v) {
  return new GoConstValue(binding.constMakeInt64(asBigInt(v, 'v')));
}
function constToInt(v) {
  const r = binding.constToInt(asConst(v, 'v')._n);
  return [r.value, r.ok];
}
function constToString(v) {
  const r = binding.constToString(asConst(v, 'v')._n);
  return [r.value, r.ok];
}
function constFloat64Val(v) {
  const r = binding.constFloat64Val(asConst(v, 'v')._n);
  return [r.value, r.ok];
}
function constCompare(x, y) {
  return binding.constCompare(asConst(x, 'x')._n, asConst(y, 'y')._n);
}
function constSign(v) {
  return binding.constSign(asConst(v, 'v')._n);
}
function constBitLen(v) {
  return binding.constBitLen(asConst(v, 'v')._n);
}
function constBinaryOp(op, x, y) {
  return new GoConstValue(
    binding.constBinaryOp(asNumber(op, 'op'), asConst(x, 'x')._n, asConst(y, 'y')._n),
  );
}
function asUintBound(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new TypeError(`gotool: ${label} must be an integer in 0..1000000`);
  }
  return value;
}
function constUnaryOp(op, y, prec) {
  return new GoConstValue(
    binding.constUnaryOp(asNumber(op, 'op'), asConst(y, 'y')._n, asUintBound(prec, 'prec')),
  );
}
function constShift(op, x, s) {
  return new GoConstValue(
    binding.constShift(asNumber(op, 'op'), asConst(x, 'x')._n, asBigInt(s, 's')),
  );
}

function asNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`gotool: ${label} must be a finite number`);
  }
  return value;
}

function asString(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`gotool: ${label} must be a string`);
  }
  return value;
}

function asBytes(value, label) {
  if (!ArrayBuffer.isView(value)) {
    throw new TypeError(`gotool: ${label} must be a Uint8Array`);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

const TOKEN = Object.freeze(binding.tokenConstants());
const SCAN_MODE = Object.freeze(binding.scanModeConstants());
const PARSE_MODE = Object.freeze(binding.parseModeConstants());
const FPRINT = Symbol('gotool.fprint');

function tokenLookup(ident) {
  return binding.tokenLookup(asString(ident, 'ident'));
}
function tokenIsKeyword(tok) {
  return binding.tokenIsKeyword(asNumber(tok, 'tok'));
}
function tokenIsExported(name) {
  return binding.tokenIsExported(asString(name, 'name'));
}
function tokenString(tok) {
  return binding.tokenString(asNumber(tok, 'tok'));
}

class GoScanError extends Error {
  constructor(pos, msg) {
    super(msg);
    this.name = 'GoScanError';
    this.pos = pos;
    this.msg = msg;
  }
}

class GoFile {
  constructor(native) {
    this._n = native;
  }
  name() {
    return this._n.name();
  }
  base() {
    return this._n.base();
  }
  size() {
    return this._n.size();
  }
  lineCount() {
    return this._n.lineCount();
  }
  lineStart(line) {
    return this._n.lineStart(asNumber(line, 'line'));
  }
  offset(p) {
    return this._n.offset(asNumber(p, 'p'));
  }
  position(p) {
    return this._n.position(asNumber(p, 'p'));
  }
  positionFor(p, adjusted) {
    return this._n.positionFor(asNumber(p, 'p'), Boolean(adjusted));
  }
  addLine(offset) {
    this._n.addLine(asNumber(offset, 'offset'));
  }
  mergeLine(line) {
    this._n.mergeLine(asNumber(line, 'line'));
  }
  setLines(lines) {
    if (!Array.isArray(lines) || lines.some((n) => typeof n !== 'number')) {
      throw new TypeError('gotool: lines must be an array of numbers');
    }
    this._n.setLines(lines);
  }
  lines() {
    return this._n.lines();
  }
}

class FileSet {
  constructor() {
    this._n = new binding.FileSet();
  }
  addFile(filename, base, size) {
    return new GoFile(
      this._n.addFile(asString(filename, 'filename'), asNumber(base, 'base'), asNumber(size, 'size')),
    );
  }
  position(pos) {
    return this._n.position(asNumber(pos, 'pos'));
  }
  positionFor(pos, adjusted) {
    return this._n.positionFor(asNumber(pos, 'pos'), Boolean(adjusted));
  }
  base() {
    return this._n.base();
  }
  iterate(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('gotool: iterate callback must be a function');
    }
    const n = this._n.fileCount();
    for (let i = 0; i < n; i++) {
      const file = this._n.fileAt(i);
      if (file && cb(new GoFile(file)) === false) break;
    }
  }
}

class Scanner {
  constructor(file, src, errorHandler, mode) {
    if (!(file instanceof GoFile)) {
      throw new TypeError('gotool: file must be a GoFile');
    }
    if (errorHandler != null && typeof errorHandler !== 'function') {
      throw new TypeError('gotool: errorHandler must be a function');
    }
    this._errorHandler = errorHandler ?? null;
    this._n = new binding.Scanner(file._n, asBytes(src, 'src'), mode == null ? 0 : asNumber(mode, 'mode'));
  }
  init(file, src, errorHandler, mode) {
    if (!(file instanceof GoFile)) {
      throw new TypeError('gotool: file must be a GoFile');
    }
    if (errorHandler != null && typeof errorHandler !== 'function') {
      throw new TypeError('gotool: errorHandler must be a function');
    }
    this._errorHandler = errorHandler ?? null;
    this._n.init(file._n, asBytes(src, 'src'), mode == null ? 0 : asNumber(mode, 'mode'));
    return this;
  }
  scan() {
    const step = this._n.scan();
    for (const e of step.errors) {
      const pos = { filename: e.filename, offset: e.offset, line: e.line, column: e.column };
      if (this._errorHandler) this._errorHandler(pos, e.msg);
    }
    return { pos: step.pos, tok: step.tok, lit: step.lit };
  }
  scanInto(out) {
    if (out == null || typeof out !== 'object') {
      throw new TypeError('gotool: scanInto requires an object');
    }
    const r = this.scan();
    out.pos = r.pos;
    out.tok = r.tok;
    out.lit = r.lit;
    return out;
  }
  error(pos, msg) {
    this._n.error(asNumber(pos, 'pos'), asString(msg, 'msg'));
  }
  get errorCount() {
    return this._n.errorCount;
  }
}

class GoParseError extends Error {
  constructor(list, partialFile, message) {
    super(message ?? (list[0] ? list[0].msg : 'parse error'));
    this.name = 'GoParseError';
    this.list = list;
    this.partialFile = partialFile ?? null;
  }
}

class UnsupportedFeatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedFeatureError';
  }
}

function parseFile(fset, filename, src, mode) {
  if (!(fset instanceof FileSet)) {
    throw new TypeError('gotool: fset must be a FileSet');
  }
  if (src == null) {
    throw new UnsupportedFeatureError('gotool: src=null file reads belong to rustd-fs');
  }
  const raw = JSON.parse(
    binding.parseFileNative(fset._n, asString(filename, 'filename'), asBytes(src, 'src'), mode == null ? 0 : asNumber(mode, 'mode')),
  );
  if (raw.file) Object.defineProperty(raw.file, FPRINT, { value: raw.fprint, enumerable: false });
  if (raw.errors && raw.errors.length) {
    throw new GoParseError(raw.errors, raw.file);
  }
  return raw.file;
}

function parseExpr(fset, expr, mode) {
  if (!(fset instanceof FileSet)) {
    throw new TypeError('gotool: fset must be a FileSet');
  }
  const raw = JSON.parse(
    binding.parseExprNative(fset._n, asString(expr, 'expr'), mode == null ? 0 : asNumber(mode, 'mode')),
  );
  if (raw.expr) Object.defineProperty(raw.expr, FPRINT, { value: raw.fprint, enumerable: false });
  if (raw.errors && raw.errors.length) {
    throw new GoParseError(raw.errors, raw.expr);
  }
  return raw.expr;
}

function astFprint(out, fset, node) {
  if (!(fset instanceof FileSet)) {
    throw new TypeError('gotool: fset must be a FileSet');
  }
  if (out == null || typeof out.write !== 'function') {
    throw new TypeError('gotool: astFprint out must have write()');
  }
  const text = node == null ? 'nil\n' : node[FPRINT];
  if (typeof text !== 'string') {
    throw new TypeError('gotool: astFprint requires a node returned by parseFile or parseExpr');
  }
  out.write(Buffer.from(text, 'utf8'));
}

function astInspect(node, f) {
  if (typeof f !== 'function') {
    throw new TypeError('gotool: astInspect callback must be a function');
  }
  walk(node, f);
}

function walk(node, f) {
  if (node == null || typeof node !== 'object' || typeof node.nodeType !== 'string') return;
  if (f(node) === false) return;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, f);
    } else {
      walk(value, f);
    }
  }
}

function astIsExported(name) {
  return tokenIsExported(asString(name, 'name'));
}

function astNewIdent(name) {
  const n = asString(name, 'name');
  return { nodeType: 'Ident', pos: 0, end: n.length, name: n };
}

module.exports.versionCompare = versionCompare;
module.exports.versionIsValid = versionIsValid;
module.exports.versionLang = versionLang;
module.exports.GoConstValue = GoConstValue;
module.exports.constMakeInt64 = constMakeInt64;
module.exports.constToInt = constToInt;
module.exports.constToString = constToString;
module.exports.constFloat64Val = constFloat64Val;
module.exports.constCompare = constCompare;
module.exports.constSign = constSign;
module.exports.constBitLen = constBitLen;
module.exports.constBinaryOp = constBinaryOp;
module.exports.constUnaryOp = constUnaryOp;
module.exports.constShift = constShift;
module.exports.TOKEN = TOKEN;
module.exports.SCAN_MODE = SCAN_MODE;
module.exports.PARSE_MODE = PARSE_MODE;
module.exports.tokenLookup = tokenLookup;
module.exports.tokenIsKeyword = tokenIsKeyword;
module.exports.tokenIsExported = tokenIsExported;
module.exports.tokenString = tokenString;
module.exports.FileSet = FileSet;
module.exports.GoFile = GoFile;
module.exports.Scanner = Scanner;
module.exports.GoScanError = GoScanError;
module.exports.GoParseError = GoParseError;
module.exports.UnsupportedFeatureError = UnsupportedFeatureError;
module.exports.parseFile = parseFile;
module.exports.parseExpr = parseExpr;
module.exports.astFprint = astFprint;
module.exports.astInspect = astInspect;
module.exports.astIsExported = astIsExported;
module.exports.astNewIdent = astNewIdent;
