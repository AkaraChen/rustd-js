'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-image';
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

class ImageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
  static code = 'ERR_IMAGE';
}
class ImageDisposedError extends ImageError { static code = 'ERR_IMAGE_DISPOSED'; }
class ImageTooLargeError extends ImageError { static code = 'ERR_IMAGE_TOO_LARGE'; }
class ImageFormatError extends ImageError { static code = 'ERR_IMAGE_FORMAT'; }
class PngFormatError extends ImageError { static code = 'ERR_PNG_FORMAT'; }
class PngUnsupportedError extends ImageError { static code = 'ERR_PNG_UNSUPPORTED'; }
class JpegFormatError extends ImageError { static code = 'ERR_JPEG_FORMAT'; }
class JpegUnsupportedError extends ImageError { static code = 'ERR_JPEG_UNSUPPORTED'; }
class GifFormatError extends ImageError { static code = 'ERR_GIF_FORMAT'; }
class GifUnsupportedError extends ImageError { static code = 'ERR_GIF_UNSUPPORTED'; }

const errors = {
  ImageError, ImageDisposedError, ImageTooLargeError, ImageFormatError,
  PngFormatError, PngUnsupportedError, JpegFormatError, JpegUnsupportedError,
  GifFormatError, GifUnsupportedError,
};

function native(fn) {
  try { return fn(); } catch (cause) {
    const msg = String(cause.message ?? cause);
    const colon = msg.indexOf(':');
    const kind = colon === -1 ? msg : msg.slice(0, colon);
    const rest = colon === -1 ? msg : msg.slice(colon + 2);
    throw new (errors[kind] ?? ImageError)(rest || msg, { cause });
  }
}

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('image: expected Uint8Array');
  }
  return value;
}

const ZR = Object.freeze({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
function rect(x0, y0, x1, y1) { return native(() => binding.rect(x0, y0, x1, y1)); }
function rectSize(r) { return native(() => binding.rectSize(r)); }
function rectDx(r) { return native(() => binding.rectDx(r)); }
function rectDy(r) { return native(() => binding.rectDy(r)); }
function rectEmpty(r) { return native(() => binding.rectEmpty(r)); }
function rectEq(a, b) { return native(() => binding.rectEq(a, b)); }
function rectIn(a, b) { return native(() => binding.rectIn(a, b)); }
function rectOverlaps(a, b) { return native(() => binding.rectOverlaps(a, b)); }
function rectIntersect(a, b) { return native(() => binding.rectIntersect(a, b)); }
function rectUnion(a, b) { return native(() => binding.rectUnion(a, b)); }
function rectAdd(r, p) { return native(() => binding.rectAdd(r, p.x, p.y)); }
function rectSub(r, p) { return native(() => binding.rectSub(r, p.x, p.y)); }
function rectInset(r, n) { return native(() => binding.rectInset(r, n)); }
function rectCanon(r) { return native(() => binding.rectCanon(r)); }

class Color {
  constructor(kind, bytesIn) {
    this.kind = kind;
    this.bytes = bytesIn;
  }
  rgba() {
    const b = this.bytes;
    if (this.kind === 'gray') {
      const y = b[0] | (b[0] << 8);
      return { r: y, g: y, b: y, a: 0xffff };
    }
    if (this.kind === 'nrgba') {
      const expand = (c) => c | (c << 8);
      const a = expand(b[3]);
      return {
        r: Math.floor(expand(b[0]) * b[3] / 0xff),
        g: Math.floor(expand(b[1]) * b[3] / 0xff),
        b: Math.floor(expand(b[2]) * b[3] / 0xff),
        a,
      };
    }
    const expand = (c) => c | (c << 8);
    return { r: expand(b[0]), g: expand(b[1]), b: expand(b[2]), a: expand(b[3] ?? 255) };
  }
}
function gray(c) { return new Color('gray', Uint8Array.of(c & 0xff)); }
function nrgba(c) { return new Color('nrgba', Uint8Array.of(c.r, c.g, c.b, c.a)); }

class Palette {
  constructor(colors) {
    this.colors = colors;
    this.length = colors.length;
    this.lut8 = new Uint8Array(0);
  }
  convert(c) {
    const i = this.index(c);
    return this.colors[i];
  }
  index(c) {
    const rgba = c.rgba ? c.rgba() : c;
    return native(() => binding.paletteIndex(
      this.colors.map((col) => col.rgba ? col.rgba() : col),
      rgba,
    ));
  }
}
function plan9Palette() {
  const colors = native(() => binding.plan9Palette()).map((c) =>
    nrgba({ r: c.r >> 8, g: c.g >> 8, b: c.b >> 8, a: c.a >> 8 }));
  return new Palette(colors);
}
function webSafePalette() {
  const colors = native(() => binding.webSafePalette()).map((c) =>
    nrgba({ r: c.r >> 8, g: c.g >> 8, b: c.b >> 8, a: c.a >> 8 }));
  return new Palette(colors);
}

class Image {
  constructor(handle) { this._n = handle; }
  get model() { return this._n.model; }
  get rect() { return this._n.rect; }
  get width() { return this._n.width; }
  get height() { return this._n.height; }
  get stride() { return this._n.stride; }
  get disposed() { return this._n.disposed; }
  at(x, y) { return native(() => this._n.atRgba(x, y)); }
  atRgba(x, y, out) {
    const c = native(() => this._n.atRgba(x, y));
    if (out) { out.r = c.r; out.g = c.g; out.b = c.b; out.a = c.a; return out; }
    return c;
  }
  rgba64At(x, y, out) { return this.atRgba(x, y, out); }
  opaque() { return native(() => this._n.opaque()); }
  set(x, y, c) {
    const rgba = c.rgba ? c.rgba() : c;
    native(() => this._n.setRgba(x, y, rgba));
  }
  subImage(r) { return new Image(native(() => this._n.subImage(r))); }
  pix() { return native(() => this._n.pix()); }
  pixCopy() { return native(() => this._n.pixCopy()); }
  dispose() { this._n.dispose(); }
  [Symbol.dispose]() { this.dispose(); }
  static rgba(r) { return new Image(native(() => binding.NativeImage.create('rgba', r))); }
  static rgba64(r) { return new Image(native(() => binding.NativeImage.create('rgba64', r))); }
  static nrgba(r) { return new Image(native(() => binding.NativeImage.create('nrgba', r))); }
  static nrgba64(r) { return new Image(native(() => binding.NativeImage.create('nrgba64', r))); }
  static alpha(r) { return new Image(native(() => binding.NativeImage.create('alpha', r))); }
  static alpha16(r) { return new Image(native(() => binding.NativeImage.create('alpha16', r))); }
  static gray(r) { return new Image(native(() => binding.NativeImage.create('gray', r))); }
  static gray16(r) { return new Image(native(() => binding.NativeImage.create('gray16', r))); }
  static paletted(r, palette) {
    const colors = palette.colors.map((c) => c.rgba ? c.rgba() : c);
    return new Image(native(() => binding.NativeImage.createPaletted(r, colors)));
  }
  static ycbcr(r, subsample) { return new Image(native(() => binding.NativeImage.createYcbcr(r, subsample))); }
  static cmyk(r) { return new Image(native(() => binding.NativeImage.create('cmyk', r))); }
  static uniform(r, c) {
    const rgba = c.rgba ? c.rgba() : c;
    return new Image(native(() => binding.NativeImage.createUniform(r, rgba)));
  }
}

function wrap(handle) { return new Image(handle); }
function maxPixels(opts) { return opts && opts.maxPixels !== undefined ? opts.maxPixels : null; }

function pngDecode(buf, opts) { return wrap(native(() => binding.pngDecode(bytes(buf), maxPixels(opts)))); }
function pngDecodeConfig(buf) { return native(() => binding.pngDecodeConfig(bytes(buf))); }
function pngEncode(img, opts) {
  const level = opts && opts.compressionLevel !== undefined ? opts.compressionLevel : 0;
  return native(() => binding.pngEncode(img._n, level));
}
function jpegDecode(buf, opts) { return wrap(native(() => binding.jpegDecode(bytes(buf), maxPixels(opts)))); }
function jpegDecodeConfig(buf) { return native(() => binding.jpegDecodeConfig(bytes(buf))); }
function jpegEncode(img, opts) {
  const quality = opts && opts.quality !== undefined ? opts.quality : 75;
  return native(() => binding.jpegEncode(img._n, quality));
}
function gifDecode(buf, opts) { return wrap(native(() => binding.gifDecode(bytes(buf), maxPixels(opts)))); }
function gifDecodeConfig(buf) { return native(() => binding.gifDecodeConfig(bytes(buf))); }
function gifDecodeAll(buf, opts) {
  const g = native(() => binding.gifDecodeAll(bytes(buf), maxPixels(opts)));
  const n = g.frameCount();
  const image = [];
  for (let i = 0; i < n; i++) image.push(wrap(g.frame(i)));
  return {
    image,
    delay: g.delay,
    loopCount: g.loopCount,
    disposal: g.disposal,
    config: g.config(),
    backgroundIndex: g.backgroundIndex,
  };
}
function gifEncode(img, opts) {
  const n = opts && opts.numColors !== undefined ? opts.numColors : 256;
  return native(() => binding.gifEncode(img._n, n));
}
function gifEncodeAll(gif) {
  return native(() => binding.gifEncodeAll(
    gif.image.map((im) => im._n),
    gif.delay,
    gif.loopCount ?? 0,
    gif.disposal ?? gif.image.map(() => 0),
    256,
  ));
}

async function collect(src) {
  const chunks = [];
  for await (const chunk of src) chunks.push(bytes(chunk));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
async function pngDecodeStream(src, opts) { return pngDecode(await collect(src), opts); }
async function jpegDecodeStream(src, opts) { return jpegDecode(await collect(src), opts); }
async function gifDecodeAllStream(src, opts) { return gifDecodeAll(await collect(src), opts); }

class PngEncoder {
  constructor(opts) { this.opts = opts; this._bytes = null; }
  async write(img) { this._bytes = pngEncode(img, this.opts); }
  toBytes() { return this._bytes ?? new Uint8Array(); }
}
class JpegEncoder {
  constructor(opts) { this.opts = opts; this._bytes = null; }
  async write(img) { this._bytes = jpegEncode(img, this.opts); }
  toBytes() { return this._bytes ?? new Uint8Array(); }
}
class GifWriter {
  constructor(opts) { this.opts = opts; this.frames = []; this.delay = []; this.disposal = []; this.loop = 0; }
  async addFrame(img, delayMs, disposal) {
    this.frames.push(img);
    this.delay.push(Math.round((delayMs ?? 100) / 10));
    this.disposal.push(disposal ?? 0);
  }
  setLoopCount(n) { this.loop = n; }
  toBytes() {
    return gifEncodeAll({ image: this.frames, delay: this.delay, loopCount: this.loop, disposal: this.disposal });
  }
}

function draw(dst, r, src, sp, op) {
  native(() => binding.drawNative(dst._n, r, src._n, sp.x, sp.y, op ?? 'over'));
}
function drawMask(dst, r, src, sp, mask, mp, op) {
  native(() => binding.drawMaskNative(dst._n, r, src._n, sp.x, sp.y, mask._n, mp.x, mp.y, op ?? 'over'));
}
function drawGeneric(img, r, src, sp, mask, mp, op) { drawMask(img, r, src, sp, mask, mp, op); }
function quantize(p, m, opts) {
  const floyd = opts && opts.drawer === 'floyd-steinberg';
  const colors = p.colors.map((c) => c.rgba ? c.rgba() : c);
  return wrap(native(() => binding.quantizeNative(colors, m._n, !!floyd)));
}

module.exports = {
  ImageError, ImageDisposedError, ImageTooLargeError, ImageFormatError,
  PngFormatError, PngUnsupportedError, JpegFormatError, JpegUnsupportedError,
  GifFormatError, GifUnsupportedError,
  ZR, rect, rectSize, rectDx, rectDy, rectEmpty, rectEq, rectIn, rectOverlaps,
  rectIntersect, rectUnion, rectAdd, rectSub, rectInset, rectCanon,
  Color, gray, nrgba, Palette, plan9Palette, webSafePalette, Image,
  pngDecode, pngDecodeConfig, pngEncode, jpegDecode, jpegDecodeConfig, jpegEncode,
  gifDecode, gifDecodeConfig, gifDecodeAll, gifEncode, gifEncodeAll,
  pngDecodeStream, jpegDecodeStream, gifDecodeAllStream,
  PngEncoder, JpegEncoder, GifWriter,
  draw, drawMask, drawGeneric, quantize,
};
