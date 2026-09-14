'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-debugfmt';
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

class DebugfmtError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
  static code = 'ERR_DEBUGFMT';
}
class BinaryFormatError extends DebugfmtError {
  static code = 'ERR_DEBUGFMT_FORMAT';
  constructor(message, kind, offset, options) {
    super(message, options);
    this.kind = kind;
    this.offset = offset;
  }
}
class UnsupportedFeatureError extends DebugfmtError {
  static code = 'ERR_DEBUGFMT_UNSUPPORTED';
  constructor(message, feature, options) {
    super(message, options);
    this.feature = feature;
  }
}
class FileClosedError extends DebugfmtError { static code = 'ERR_DEBUGFMT_CLOSED'; }
class BlockedRegionError extends DebugfmtError { static code = 'ERR_DEBUGFMT_BLOCKED'; }

function wrapNative(fn) {
  try {
    return fn();
  } catch (cause) {
    const text = String(cause.message ?? cause);
    const [code, ...rest] = text.split(':');
    if (code === 'BinaryFormatError') {
      const kind = rest[0] ?? 'format';
      const offset = BigInt(rest[1] || 0);
      throw new BinaryFormatError(rest.slice(2).join(':').trim() || text, kind, offset, { cause });
    }
    if (code === 'UnsupportedFeatureError') {
      throw new UnsupportedFeatureError(rest.join(':').trim() || text, rest[0] ?? 'feature', { cause });
    }
    if (code === 'FileClosedError') {
      throw new FileClosedError(rest.join(':').trim() || 'debugfmt: file is closed', { cause });
    }
    if (code === 'BlockedRegionError') {
      throw new BlockedRegionError(rest.join(':').trim() || text, { cause });
    }
    throw new DebugfmtError(text, { cause });
  }
}

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('debugfmt: expected Uint8Array');
  }
  return value;
}

function nativeOpts(opts) {
  if (opts === undefined) return { max: null, base: null };
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError('debugfmt: options must be an object');
  }
  let max = null;
  let base = null;
  if (opts.maxSectionBytes !== undefined) {
    if (typeof opts.maxSectionBytes === 'bigint') max = opts.maxSectionBytes;
    else if (typeof opts.maxSectionBytes === 'number' && Number.isFinite(opts.maxSectionBytes) && opts.maxSectionBytes >= 0) {
      max = BigInt(Math.floor(opts.maxSectionBytes));
    } else {
      throw new TypeError('debugfmt: maxSectionBytes must be a non-negative number or bigint');
    }
  }
  if (opts.base !== undefined) {
    if (typeof opts.base !== 'bigint') throw new TypeError('debugfmt: base must be a bigint');
    base = opts.base;
  }
  return { max, base };
}

function wrapSection(native, raw) {
  return {
    name: raw.name,
    type: raw.type,
    flags: raw.flags,
    addr: raw.addr,
    offset: raw.offset,
    size: raw.size,
    link: raw.link,
    info: raw.info,
    addralign: raw.addralign,
    entsize: raw.entsize,
    compressed: raw.compressed,
    data() { return wrapNative(() => native.sectionData(raw.name)); },
  };
}

function liftModule(m) {
  if (!m) return m;
  const out = { path: m.path, version: m.version, sum: m.sum };
  if (m.replacePath) {
    out.replace = { path: m.replacePath, version: m.replaceVersion ?? '', sum: m.replaceSum ?? '' };
  }
  return out;
}
function liftBuildInfo(info) {
  return {
    goVersion: info.goVersion,
    path: info.path,
    main: liftModule(info.main),
    deps: (info.deps ?? []).map(liftModule),
    settings: info.settings ?? [],
  };
}

function liftDwarfValue(attr) {
  switch (attr.kind) {
    case 'addr': return { kind: 'addr', value: attr.valueU64 ?? 0n };
    case 'i64': return { kind: 'i64', value: attr.valueI64 ?? 0n };
    case 'str': return { kind: 'str', value: attr.valueStr ?? '' };
    case 'block': return { kind: 'block', value: attr.valueBuf ?? new Uint8Array() };
    case 'ref': return { kind: 'ref', value: attr.valueU64 ?? 0n };
    case 'bool':
    case 'flag': return { kind: attr.kind, value: Boolean(attr.valueBool) };
    case 'float': return { kind: 'float', value: attr.valueF64 ?? 0 };
    default: return { kind: 'u64', value: attr.valueU64 ?? 0n };
  }
}

function liftEntry(raw) {
  return {
    tag: raw.tag,
    tagValue: raw.tagValue,
    offset: raw.offset,
    children: raw.children,
    attrs: (raw.attrs ?? []).map((a) => ({ attr: a.attr, class: a.class, value: liftDwarfValue(a) })),
    type() { return null; },
  };
}

class LineReader {
  constructor(rows) {
    this._rows = rows ?? [];
    this._i = 0;
    this._ended = false;
  }
  next() {
    if (this._ended || this._i >= this._rows.length) return null;
    const row = this._rows[this._i++];
    if (row.endSequence) this._ended = true;
    return row;
  }
  reset() {
    this._i = 0;
    this._ended = false;
  }
  tell() {
    if (this._ended || this._i >= this._rows.length) return 0n;
    return this._rows[this._i].address;
  }
  files() { return [...new Set(this._rows.map((r) => r.file).filter(Boolean))]; }
  seek(addr) {
    this._ended = false;
    let lastIdx = -1;
    for (let i = 0; i < this._rows.length; i++) {
      const row = this._rows[i];
      if (row.endSequence) {
        if (row.address > addr && lastIdx >= 0) {
          this._i = lastIdx;
          return;
        }
        lastIdx = -1;
        continue;
      }
      if (row.address > addr) {
        this._i = lastIdx >= 0 ? lastIdx : i;
        return;
      }
      lastIdx = i;
    }
    this._i = lastIdx >= 0 ? lastIdx : this._rows.length;
  }
  seekPC(pc) {
    let last = null;
    for (const row of this._rows) {
      if (row.endSequence) {
        if (row.address > pc && last) return last.file;
        last = null;
        continue;
      }
      if (row.address > pc) return last ? last.file : null;
      last = row;
    }
    return last ? last.file : null;
  }
}

function wrapDwarf(native) {
  const reader = {
    get version() { return native.version; },
    get addressSize() { return native.addressSize; },
    get byteOrder() { return native.byteOrder; },
    entries() { return wrapNative(() => native.entries()).map(liftEntry); },
    iterateEntries(cb) {
      for (const entry of reader.entries()) {
        if (cb(entry) === false) break;
      }
    },
    entryAt(offset) {
      const raw = wrapNative(() => native.entryAt(offset));
      return raw ? liftEntry(raw) : null;
    },
    seekPC(addr) {
      const raw = wrapNative(() => native.seekPc(addr));
      return raw ? liftEntry(raw) : null;
    },
    lineReader() { return new LineReader(wrapNative(() => native.lineEntries())); },
    ranges(entry) { return wrapNative(() => native.rangesForOffset(entry.offset)); },
    types() { return wrapNative(() => native.types()); },
  };
  return reader;
}

function wrapGosym(native) {
  return {
    pcToLine(pc) {
      const row = wrapNative(() => native.pcToLine(pc));
      return {
        file: row.file,
        line: row.line,
        fn: row.func ?? null,
        inlineFrames: (row.inlineFrames ?? []).map((f) => ({ file: f.file, line: f.line, fn: f.fnName })),
      };
    },
    lineToPC(file, line) { return wrapNative(() => native.lineToPc(file, line)); },
    pcToFunc(pc) { return wrapNative(() => native.pcToFunc(pc)); },
    lookupFunc(name) { return wrapNative(() => native.lookupFunc(name)); },
    lookupSym(name) { return wrapNative(() => native.lookupSym(name)); },
    symByAddr(addr) { return wrapNative(() => native.symByAddr(addr)); },
    funcs() { return wrapNative(() => native.funcs()); },
  };
}

function wrapFile(native) {
  const file = {
    get kind() { return native.kind; },
    get size() { return native.size; },
    get isFat() { return native.isFat; },
    get closed() { return native.closed; },
    arch() { return wrapNative(() => native.arch()); },
    endian() { return wrapNative(() => native.endian()); },
    close() { native.close(); },
    sections() { return wrapNative(() => native.sections()).map((s) => wrapSection(native, s)); },
    section(name) {
      const raw = wrapNative(() => native.section(name));
      return raw ? wrapSection(native, raw) : null;
    },
    segments() { return wrapNative(() => native.segments()); },
    symbols() { return wrapNative(() => native.symbols()); },
    iterateSymbols(cb) {
      for (const s of file.symbols()) {
        if (cb(s) === false) break;
      }
    },
    dynamicSymbols() { return wrapNative(() => native.dynamicSymbols()); },
    importedSymbols() { return wrapNative(() => native.importedSymbols()); },
    importedLibraries() { return wrapNative(() => native.importedLibraries()); },
    entryPoint() { return wrapNative(() => native.entryPoint()); },
    hasDebugInfo() { return wrapNative(() => native.hasDebugInfo()); },
    buildInfo() {
      const info = wrapNative(() => native.buildInfo());
      return info ? liftBuildInfo(info) : null;
    },
    dwarf() {
      const nativeDwarf = wrapNative(() => native.dwarf());
      return nativeDwarf ? wrapDwarf(nativeDwarf) : null;
    },
    gosym() {
      const nativeGosym = wrapNative(() => native.gosym());
      return nativeGosym ? wrapGosym(nativeGosym) : null;
    },
    dynamicStrings() { return wrapNative(() => native.dynamicStrings()); },
    dynamicValue(tag) { return wrapNative(() => native.dynamicValue(tag)); },
    _native: native,
  };
  return file;
}

function sniff(head) {
  return binding.nativeSniff(bytes(head));
}

function open(path, opts) {
  if (typeof path !== 'string') throw new TypeError('debugfmt: path must be a string');
  const { max, base } = nativeOpts(opts);
  return wrapFile(wrapNative(() => binding.nativeOpen(path, max, base)));
}

function openBytes(buf, opts) {
  const { max, base } = nativeOpts(opts);
  return wrapFile(wrapNative(() => binding.nativeOpenBytes(bytes(buf), max, base)));
}

function readBuildInfoBytes(b) {
  return liftBuildInfo(wrapNative(() => binding.nativeReadBuildinfoBytes(bytes(b))));
}

function readBuildInfoFile(path) {
  const file = open(path);
  try {
    const info = file.buildInfo();
    if (!info) throw new BinaryFormatError('not a Go executable', 'buildinfo', 0n);
    return info;
  } finally {
    file.close();
  }
}

class ElfFile {
  constructor(file) {
    if (file.kind !== 'elf') throw new BinaryFormatError('not ELF', 'kind', 0n);
    this._file = file;
  }
  static open(path, opts) { return new ElfFile(open(path, opts)); }
  static openBytes(b, opts) { return new ElfFile(openBytes(b, opts)); }
  header() {
    const h = wrapNative(() => this._file._native.elfHeader());
    return { class: h.class, data: h.data, osabi: h.osabi, abiVersion: h.abiVersion, machine: h.machine, type: h.type, entry: h.entry, version: h.version, flags: h.flags };
  }
  class() { return this.header().class; }
  osabi() { return this.header().osabi; }
  machine() { return this.header().machine; }
  type() { return this.header().type; }
  progHeaders() { return wrapNative(() => this._file._native.elfProgHeaders()); }
  dynamicTags() { return {}; }
  close() { this._file.close(); }
  file() { return this._file; }
}

class MachOFile {
  constructor(file) {
    if (file.kind !== 'macho') throw new BinaryFormatError('not Mach-O', 'kind', 0n);
    this._file = file;
  }
  static open(path, opts) { return new MachOFile(open(path, opts)); }
  header() { return wrapNative(() => this._file._native.machoHeader()); }
  dylibs() { return wrapNative(() => this._file._native.machoDylibs()); }
  close() { this._file.close(); }
  file() { return this._file; }
}

class PeFile {
  constructor(file) {
    if (file.kind !== 'pe') throw new BinaryFormatError('not PE', 'kind', 0n);
    this._file = file;
  }
  static open(path, opts) { return new PeFile(open(path, opts)); }
  static openBytes(b, opts) { return new PeFile(openBytes(b, opts)); }
  coffHeader() { return wrapNative(() => this._file._native.coffHeader()); }
  close() { this._file.close(); }
  file() { return this._file; }
}

module.exports = {
  sniff, open, openBytes, readBuildInfoFile, readBuildInfoBytes,
  ElfFile, MachOFile, PeFile, LineReader,
  DebugfmtError, BinaryFormatError, UnsupportedFeatureError, FileClosedError, BlockedRegionError,
};
