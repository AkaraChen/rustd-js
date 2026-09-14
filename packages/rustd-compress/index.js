'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-compress';
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

class Bzip2FormatError extends Error {
  constructor(message, offset, options) {
    super(message, options);
    this.name = 'Bzip2FormatError';
    this.offset = offset;
  }
}
class LzwFormatError extends Error {
  constructor(message, bitOffset, options) {
    super(message, options);
    this.name = 'LzwFormatError';
    this.bitOffset = bitOffset;
  }
}
class LzwConfigError extends RangeError {
  constructor(message, options) {
    super(message, options);
    this.name = 'LzwConfigError';
  }
}

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('compress: expected Uint8Array');
  }
  return value;
}

function native(fn) {
  try {
    return fn();
  } catch (cause) {
    const text = String(cause.message ?? cause);
    const parts = text.split(':');
    const kind = parts[0];
    const loc = Number(parts[1] ?? 0);
    const message = parts.slice(2).join(':');
    if (kind === 'Bzip2FormatError') throw new Bzip2FormatError(message, loc, { cause });
    if (kind === 'LzwFormatError') throw new LzwFormatError(message, loc, { cause });
    if (kind === 'LzwConfigError') throw new LzwConfigError(message, { cause });
    throw cause;
  }
}

function lzwOptions(opts) {
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError('compress: LzwOptions required');
  }
  if (opts.order !== 'lsb' && opts.order !== 'msb') {
    throw new LzwConfigError('lzw: unknown order');
  }
  const litWidth = opts.litWidth;
  if (typeof litWidth !== 'number' || !Number.isInteger(litWidth)) {
    throw new LzwConfigError(`lzw: litWidth ${String(litWidth)} out of range`);
  }
  if (litWidth < 2 || litWidth > 8) {
    throw new LzwConfigError(`lzw: litWidth ${litWidth} out of range`);
  }
  return { order: opts.order, litWidth };
}

function chunkSize(opts) {
  if (opts === undefined) return 1 << 20;
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError('compress: options must be an object');
  }
  if (opts.chunkSize === undefined) return 1 << 20;
  if (typeof opts.chunkSize !== 'number' || !Number.isInteger(opts.chunkSize) || opts.chunkSize <= 0) {
    throw new TypeError('compress: chunkSize must be a positive integer');
  }
  return opts.chunkSize;
}

function bzip2Decompress(data) {
  return native(() => binding.bzip2Decompress(bytes(data)));
}
function lzwCompress(data, opts) {
  const { order, litWidth } = lzwOptions(opts);
  return native(() => binding.lzwCompress(bytes(data), order, litWidth));
}
function lzwDecompress(data, opts) {
  const { order, litWidth } = lzwOptions(opts);
  return native(() => binding.lzwDecompress(bytes(data), order, litWidth));
}

class Bzip2Decompressor {
  constructor(opts) {
    this._chunkSize = chunkSize(opts);
    this._handle = native(() => new binding.NativeBzip2Decompressor(this._chunkSize));
  }
  write(chunk) { native(() => this._handle.write(bytes(chunk))); }
  read(maxBytes) {
    if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 0)) {
      throw new TypeError('compress: maxBytes must be a non-negative integer');
    }
    return native(() => this._handle.read(maxBytes));
  }
  end() { native(() => this._handle.end()); }
  reset() { native(() => this._handle.reset()); }
}

class LzwDecompressor {
  constructor(opts) {
    const { order, litWidth } = lzwOptions(opts);
    this._order = order;
    this._litWidth = litWidth;
    this._handle = native(() => new binding.NativeLzwDecompressor(order, litWidth));
  }
  write(chunk) { native(() => this._handle.write(bytes(chunk))); }
  read(maxBytes) {
    if (maxBytes !== undefined && (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 0)) {
      throw new TypeError('compress: maxBytes must be a non-negative integer');
    }
    return native(() => this._handle.read(maxBytes));
  }
  end() { native(() => this._handle.end()); }
  reset() { native(() => this._handle.reset()); }
}

class LzwCompressor {
  constructor(opts) {
    const { order, litWidth } = lzwOptions(opts);
    this._handle = native(() => new binding.NativeLzwCompressor(order, litWidth));
  }
  write(chunk) { native(() => this._handle.write(bytes(chunk))); }
  finish() { return native(() => this._handle.finish()); }
}

async function* pull(handle, ended) {
  for (;;) {
    const chunk = handle.read();
    if (!chunk.length) break;
    yield chunk;
  }
  if (ended) return;
}

async function* bzip2DecompressStream(chunks) {
  const decoder = new Bzip2Decompressor();
  for await (const chunk of chunks) {
    decoder.write(chunk);
    yield* pull(decoder, false);
  }
  decoder.end();
  yield* pull(decoder, true);
}

async function* lzwCompressStream(chunks, opts) {
  const encoder = new LzwCompressor(opts);
  for await (const chunk of chunks) encoder.write(chunk);
  const done = encoder.finish();
  if (done.length) yield done;
}

module.exports = {
  bzip2Decompress, lzwCompress, lzwDecompress,
  Bzip2Decompressor, LzwDecompressor, LzwCompressor,
  bzip2DecompressStream, lzwCompressStream,
  Bzip2FormatError, LzwFormatError, LzwConfigError,
};
