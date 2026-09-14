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

module.exports.versionCompare = versionCompare;
module.exports.versionIsValid = versionIsValid;
module.exports.versionLang = versionLang;
module.exports.TOKEN = TOKEN;
module.exports.SCAN_MODE = SCAN_MODE;
module.exports.tokenLookup = tokenLookup;
module.exports.tokenIsKeyword = tokenIsKeyword;
module.exports.tokenIsExported = tokenIsExported;
module.exports.tokenString = tokenString;
module.exports.FileSet = FileSet;
module.exports.GoFile = GoFile;
module.exports.Scanner = Scanner;
module.exports.GoScanError = GoScanError;
