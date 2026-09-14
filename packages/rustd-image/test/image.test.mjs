import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Image, rect, ZR, rectSize, rectIntersect, rectEmpty, nrgba, gray,
  plan9Palette, pngEncode, pngDecode, pngDecodeConfig,
  jpegEncode, jpegDecode, jpegDecodeConfig,
  gifEncode, gifDecode, gifDecodeAll, gifDecodeConfig,
  draw, ImageDisposedError, ImageTooLargeError, PngFormatError,
} from '../index.mjs';

test('rect geometry matches Go empty/intersect basics', () => {
  assert.equal(rectEmpty(ZR), true);
  const r = rect(1, 2, 5, 8);
  assert.deepEqual(rectSize(r), { x: 4, y: 6 });
  const i = rectIntersect(r, rect(3, 0, 9, 4));
  assert.equal(i.minX, 3);
  assert.equal(i.minY, 2);
  assert.equal(i.maxX, 5);
  assert.equal(i.maxY, 4);
});

test('RGBA set/at and subImage alias via set', () => {
  const img = Image.rgba(rect(0, 0, 4, 4));
  img.set(1, 1, nrgba({ r: 10, g: 20, b: 30, a: 255 }));
  const c = img.atRgba(1, 1);
  assert.equal(c.r >> 8, 10);
  assert.equal(c.g >> 8, 20);
  assert.equal(c.b >> 8, 30);
  const sub = img.subImage(rect(1, 1, 3, 3));
  sub.set(1, 1, nrgba({ r: 1, g: 2, b: 3, a: 255 }));
  assert.equal(img.atRgba(1, 1).r >> 8, 1);
  img.dispose();
  assert.throws(() => img.at(0, 0), ImageDisposedError);
});

test('gray constructor and opaque', () => {
  const img = Image.gray(rect(0, 0, 2, 2));
  img.set(0, 0, gray(200));
  assert.equal(img.opaque(), true);
  assert.equal(img.model, 'gray');
});

test('plan9 palette is 256 colors', () => {
  const p = plan9Palette();
  assert.equal(p.length, 256);
  assert.equal(p.index(nrgba({ r: 0, g: 0, b: 0, a: 255 })), 0);
});

test('png roundtrip preserves opaque pixels', () => {
  const img = Image.nrgba(rect(0, 0, 8, 8));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      img.set(x, y, nrgba({ r: x * 32, g: y * 32, b: 128, a: 255 }));
    }
  }
  const encoded = pngEncode(img, { compressionLevel: -1 });
  const cfg = pngDecodeConfig(encoded);
  assert.equal(cfg.width, 8);
  assert.equal(cfg.height, 8);
  const dec = pngDecode(encoded);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = img.atRgba(x, y);
      const b = dec.atRgba(x, y);
      assert.equal(a.r >> 8, b.r >> 8);
      assert.equal(a.g >> 8, b.g >> 8);
      assert.equal(a.b >> 8, b.b >> 8);
    }
  }
});

test('jpeg encode/decode config and maxPixels', () => {
  const img = Image.nrgba(rect(0, 0, 8, 8));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    img.set(x, y, nrgba({ r: 200, g: 10, b: 10, a: 255 }));
  }
  const encoded = jpegEncode(img, { quality: 75 });
  const cfg = jpegDecodeConfig(encoded);
  assert.equal(cfg.width, 8);
  assert.equal(cfg.height, 8);
  assert.equal(cfg.colorModel, 'ycbcr');
  const dec = jpegDecode(encoded);
  assert.equal(dec.width, 8);
  assert.throws(() => jpegDecode(encoded, { maxPixels: 4 }), ImageTooLargeError);
});

test('gif encode/decode', () => {
  const img = Image.nrgba(rect(0, 0, 8, 8));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    img.set(x, y, nrgba({ r: x * 30, g: 80, b: y * 30, a: 255 }));
  }
  const encoded = gifEncode(img, { numColors: 256 });
  const cfg = gifDecodeConfig(encoded);
  assert.equal(cfg.width, 8);
  assert.equal(cfg.height, 8);
  const dec = gifDecode(encoded);
  assert.equal(dec.width, 8);
});

test('empty PNG encode is PngFormatError', () => {
  assert.throws(() => pngEncode(Image.nrgba(rect(0, 0, 0, 0))), PngFormatError);
});

test('draw src copies pixels', () => {
  const dst = Image.rgba(rect(0, 0, 2, 2));
  const src = Image.nrgba(rect(0, 0, 2, 2));
  src.set(0, 0, nrgba({ r: 9, g: 8, b: 7, a: 255 }));
  draw(dst, rect(0, 0, 2, 2), src, { x: 0, y: 0 }, 'src');
  assert.equal(dst.atRgba(0, 0).r >> 8, 9);
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function bombPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function gifWithFramesAndScreen(n, screenW, screenH) {
  const img = Image.nrgba(rect(0, 0, 8, 8));
  img.set(0, 0, nrgba({ r: 9, g: 8, b: 7, a: 255 }));
  const encoded = Buffer.from(gifEncode(img, { numColors: 16 }));
  img.dispose();
  const trailer = encoded.lastIndexOf(0x3b);
  const image = encoded.indexOf(0x2c, 13);
  assert.ok(trailer > 13 && image > 13);
  let start = image;
  if (image >= 8 && encoded[image - 8] === 0x21 && encoded[image - 7] === 0xf9) start = image - 8;
  const block = encoded.subarray(start, trailer);
  const parts = [encoded.subarray(0, start)];
  for (let i = 0; i < n; i++) parts.push(block);
  parts.push(Buffer.from([0x3b]));
  const out = Buffer.concat(parts);
  out.writeUInt16LE(screenW, 6);
  out.writeUInt16LE(screenH, 8);
  return out;
}

test('malicious 100000×100000 PNG DecodeConfig RSS <10MB and Decode maxPixels (#19 §4.8)', () => {
  const tinyImg = Image.nrgba(rect(0, 0, 1, 1));
  const tiny = pngEncode(tinyImg, { compressionLevel: -1 });
  tinyImg.dispose();
  pngDecodeConfig(tiny);
  const bomb = bombPng(100000, 100000);
  const before = process.memoryUsage().rss;
  const cfg = pngDecodeConfig(bomb);
  const after = process.memoryUsage().rss;
  const delta = Math.max(0, after - before);
  assert.equal(cfg.width, 100000);
  assert.equal(cfg.height, 100000);
  assert.ok(delta < 10 * 1024 * 1024, `DecodeConfig RSS grew ${delta} bytes, want <10MB`);
  assert.throws(() => pngDecode(bomb, { maxPixels: 1_000_000 }), ImageTooLargeError);
});

test('malicious GIF DecodeAll intercepts 1000 frames × large screen via maxPixels (#19 §4.8)', () => {
  const buf = gifWithFramesAndScreen(1000, 10000, 10000);
  const cfg = gifDecodeConfig(buf);
  assert.equal(cfg.width, 10000);
  assert.equal(cfg.height, 10000);
  assert.throws(() => gifDecodeAll(buf, { maxPixels: 1_000_000 }), ImageTooLargeError);
  assert.throws(() => gifDecode(buf, { maxPixels: 1_000_000 }), ImageTooLargeError);
});
