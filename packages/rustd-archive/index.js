'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const name = 'rustd-archive';
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

class ArchiveError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
}
class TarFormatError extends ArchiveError {
  static code = 'ERR_TAR_FORMAT';
  constructor(message, options) {
    super(message, options);
    this.offset = options?.offset ?? 0;
  }
}
class ZipFormatError extends ArchiveError {
  static code = 'ERR_ZIP_FORMAT';
  constructor(message, options) {
    super(message, options);
    this.offset = options?.offset ?? 0;
  }
}

function wrap(fn) {
  try { return fn(); } catch (cause) {
    const msg = String(cause.message ?? cause);
    const isTar = msg.startsWith('TarFormatError');
    const isZip = msg.startsWith('ZipFormatError');
    if (!isTar && !isZip) throw cause;
    const at = msg.lastIndexOf(' @ ');
    const offset = at >= 0 ? Number(msg.slice(at + 3)) : 0;
    const colon = msg.indexOf(': ');
    const text = colon >= 0 ? msg.slice(colon + 2, at >= 0 ? at : undefined) : msg;
    const ErrorClass = isTar ? TarFormatError : ZipFormatError;
    throw new ErrorClass(text, { cause, offset });
  }
}

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('archive: expected Uint8Array');
  }
  return value;
}

function tarNative(entry) {
  const data = entry.data === undefined ? new Uint8Array() : bytes(entry.data);
  return {
    json: JSON.stringify({
      name: entry.name,
      type: entry.type ?? (String(entry.name).endsWith('/') ? 'dir' : 'reg'),
      size: entry.size ?? data.length,
      mode: entry.mode ?? 0o644,
      uid: entry.uid ?? 0,
      gid: entry.gid ?? 0,
      mtime_ms: entry.mtime instanceof Date ? entry.mtime.getTime() : undefined,
      linkname: entry.linkname ?? '',
      uname: entry.uname ?? '',
      gname: entry.gname ?? '',
      pax: entry.pax ?? {},
    }),
    data,
  };
}

function zipNative(entry) {
  const data = entry.data === undefined ? new Uint8Array() : bytes(entry.data);
  return {
    json: JSON.stringify({
      name: entry.name,
      method: entry.method ?? (data.length === 0 ? 0 : 8),
      size: entry.size ?? data.length,
      compressed_size: entry.compressedSize ?? 0,
      crc32: entry.crc32 ?? 0,
      mtime_ms: entry.modified instanceof Date ? entry.modified.getTime() : undefined,
      comment: entry.comment ?? '',
      mode: entry.mode,
      non_utf8: entry.nonUtf8 === true,
      raw_name: entry.rawName ? Array.from(bytes(entry.rawName)) : undefined,
    }),
    data,
  };
}

function fromTar(native) {
  const m = JSON.parse(native.json);
  const entry = {
    name: m.name,
    type: m.type,
    size: Number(m.size),
    mode: m.mode,
    data: native.data,
  };
  if (m.uid) entry.uid = m.uid;
  if (m.gid) entry.gid = m.gid;
  if (m.mtime_ms != null) entry.mtime = new Date(m.mtime_ms);
  if (m.linkname) entry.linkname = m.linkname;
  if (m.uname) entry.uname = m.uname;
  if (m.gname) entry.gname = m.gname;
  if (m.pax && Object.keys(m.pax).length) entry.pax = m.pax;
  if (m.typeflag) entry.typeflag = m.typeflag;
  return entry;
}

function fromZip(native) {
  const m = JSON.parse(native.json);
  const entry = {
    name: m.name,
    method: m.method === 8 ? 8 : 0,
    size: Number(m.size),
    compressedSize: Number(m.compressed_size ?? 0),
    crc32: m.crc32 >>> 0,
    data: native.data,
  };
  if (m.mtime_ms != null) entry.modified = new Date(m.mtime_ms);
  if (m.comment) entry.comment = m.comment;
  entry.mode = (m.mode ?? 0) >>> 0;
  if (m.non_utf8) {
    entry.nonUtf8 = true;
    if (m.raw_name) entry.rawName = Uint8Array.from(m.raw_name);
  }
  return entry;
}

function tarCreate(entries, _opts) {
  if (!Array.isArray(entries)) throw new TypeError('archive: entries must be an array');
  return wrap(() => binding.tarCreate(entries.map(tarNative)));
}
function tarExtract(buf, _opts) {
  return (wrap(() => binding.tarExtract(bytes(buf))) ?? []).map(fromTar);
}
function zipCreate(entries, _opts) {
  if (!Array.isArray(entries)) throw new TypeError('archive: entries must be an array');
  return wrap(() => binding.zipCreate(entries.map(zipNative)));
}
function zipExtract(buf, _opts) {
  return (wrap(() => binding.zipExtract(bytes(buf))) ?? []).map(fromZip);
}

class TarWriter {
  constructor(opts) {
    this._n = new binding.NativeTarWriter();
    this._opts = opts;
  }
  writeHeader(entry) { wrap(() => this._n.writeHeader(tarNative(entry))); }
  write(data) { wrap(() => this._n.write(bytes(data))); }
  end() { return wrap(() => this._n.finish()); }
}

class ZipWriter {
  constructor(opts) {
    this._n = new binding.NativeZipWriter();
    this._opts = opts;
  }
  writeHeader(entry) { wrap(() => this._n.writeHeader(zipNative(entry))); }
  write(data) { wrap(() => this._n.write(bytes(data))); }
  end() { return wrap(() => this._n.finish()); }
}

class TarReader extends EventEmitter {
  constructor(opts) {
    super();
    this._n = new binding.NativeTarReader();
    this._opts = opts;
  }
  write(chunk) {
    for (const e of wrap(() => this._n.write(bytes(chunk)))) this.emit('entry', fromTar(e));
  }
  end() {
    for (const e of wrap(() => this._n.finish())) this.emit('entry', fromTar(e));
  }
}

class ZipReader extends EventEmitter {
  constructor(opts) {
    super();
    this._n = new binding.NativeZipReader();
    this._opts = opts;
  }
  write(chunk) { this._n.write(bytes(chunk)); }
  end() {
    for (const e of wrap(() => this._n.finish())) this.emit('entry', fromZip(e));
  }
}

module.exports = {
  ArchiveError, TarFormatError, ZipFormatError,
  tarCreate, tarExtract, zipCreate, zipExtract,
  TarWriter, TarReader, ZipWriter, ZipReader,
};
