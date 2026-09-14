import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  pngDecode, pngDecodeConfig, pngEncode, jpegDecodeConfig, gifDecode, gifDecodeAll, gifDecodeConfig,
  plan9Palette, webSafePalette, nrgba, draw, drawMask, quantize, Image, rect, PngFormatError,
} from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(dir, 'go-fixtures.json');

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pixdump(img) {
  let s = '';
  const w = img.width;
  const h = img.height;
  const out = { r: 0, g: 0, b: 0, a: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = img.atRgba(x, y, out);
      s += [c.r, c.g, c.b, c.a].map((n) => n.toString(16).padStart(4, '0')).join('');
    }
  }
  return s;
}

test('Go fixtures exist', () => {
  assert.equal(existsSync(fixturePath), true, 'run mise exec -- go run ./test/gofixtures . from packages/rustd-image/test');
});

test('PNG DecodeConfig and pixdump match Go testdata / pngsuite', () => {
  const { fixtures } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const pngs = fixtures.filter((f) => f.kind === 'png');
  assert.ok(pngs.length >= 30, `expected >=30 png fixtures, got ${pngs.length}`);
  let interlaced = 0;
  let trns = 0;
  for (const f of pngs) {
    const buf = hexToBytes(f.bytesHex);
    const cfg = pngDecodeConfig(buf);
    assert.equal(cfg.width, f.width, `${f.name} width`);
    assert.equal(cfg.height, f.height, `${f.name} height`);
    assert.equal(cfg.colorModel, f.colorModel, `${f.name} colorModel`);
    const img = pngDecode(buf);
    assert.equal(img.width, f.width, `${f.name} decode width`);
    assert.equal(img.height, f.height, `${f.name} decode height`);
    assert.equal(pixdump(img), f.pix, `${f.name} pixdump`);
    img.dispose();
    if (f.interlace) interlaced += 1;
    if (f.name.includes('trns') || f.name.startsWith('ftb')) trns += 1;
  }
  assert.ok(interlaced >= 2, `expected Adam7 fixtures, got ${interlaced}`);
  assert.ok(trns >= 5, `expected tRNS fixtures, got ${trns}`);
});

test('JPEG DecodeConfig matches Go for several qualities', () => {
  const { fixtures } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const jpegs = fixtures.filter((f) => f.kind === 'jpeg');
  assert.ok(jpegs.length >= 4);
  for (const f of jpegs) {
    const buf = hexToBytes(f.bytesHex);
    const cfg = jpegDecodeConfig(buf);
    assert.equal(cfg.width, f.width, f.name);
    assert.equal(cfg.height, f.height, f.name);
    assert.equal(cfg.colorModel, f.colorModel, f.name);
  }
});

test('GIF DecodeConfig, first-frame pixdump, and DecodeAll structure match Go', () => {
  const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const gifs = payload.fixtures.filter((f) => f.kind === 'gif');
  assert.ok(gifs.length >= 1);
  for (const f of gifs) {
    const buf = hexToBytes(f.bytesHex);
    const cfg = gifDecodeConfig(buf);
    assert.equal(cfg.width, f.width, f.name);
    assert.equal(cfg.height, f.height, f.name);
    const img = gifDecode(buf);
    assert.equal(pixdump(img), f.pix, `${f.name} first-frame pixdump`);
    img.dispose();
  }
  const all = payload.extra.gifAll;
  const two = gifs.find((f) => f.name === 'twoframe');
  const decoded = gifDecodeAll(hexToBytes(two.bytesHex));
  assert.equal(decoded.loopCount, all.loopCount);
  assert.equal(decoded.image.length, all.frames.length);
  for (let i = 0; i < all.frames.length; i++) {
    const got = decoded.image[i];
    const exp = all.frames[i];
    assert.equal(got.width, exp.width, `frame ${i} width`);
    assert.equal(got.height, exp.height, `frame ${i} height`);
    assert.equal(decoded.delay[i], exp.delay, `frame ${i} delay`);
    assert.equal(decoded.disposal[i], exp.disposal, `frame ${i} disposal`);
    assert.equal(pixdump(got), exp.pix, `frame ${i} pixdump`);
  }
});

test('Plan9 Index and draw Over/Src still match Go', () => {
  const { extra } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const pal = plan9Palette();
  for (const row of extra.plan9Index) {
    const c = nrgba({ r: row.r >> 8, g: row.g >> 8, b: row.b >> 8, a: row.a >> 8 });
    assert.equal(pal.index(c), row.index);
  }
  const dst = Image.rgba(rect(0, 0, 4, 4));
  const src = Image.nrgba(rect(0, 0, 4, 4));
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      dst.set(x, y, nrgba({ r: 0, g: 0, b: 255, a: 255 }));
      src.set(x, y, nrgba({ r: 255, g: 0, b: 0, a: 128 }));
    }
  }
  const over = Image.rgba(rect(0, 0, 4, 4));
  draw(over, rect(0, 0, 4, 4), dst, { x: 0, y: 0 }, 'src');
  draw(over, rect(0, 0, 4, 4), src, { x: 0, y: 0 }, 'over');
  assert.equal(pixdump(over), extra.drawOver);
  const srcOp = Image.rgba(rect(0, 0, 4, 4));
  draw(srcOp, rect(0, 0, 4, 4), dst, { x: 0, y: 0 }, 'src');
  draw(srcOp, rect(0, 0, 4, 4), src, { x: 0, y: 0 }, 'src');
  assert.equal(pixdump(srcOp), extra.drawSrc);
});

function sampleNRGBA8() {
  const img = Image.nrgba(rect(0, 0, 8, 8));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      img.set(x, y, nrgba({ r: x * 32, g: y * 32, b: 128, a: 255 }));
    }
  }
  img.set(0, 0, nrgba({ r: 255, g: 0, b: 0, a: 128 }));
  return img;
}

function gradient16() {
  const img = Image.nrgba(rect(0, 0, 16, 16));
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      img.set(x, y, nrgba({ r: x * 16, g: y * 16, b: (x + y) * 8, a: 255 }));
    }
  }
  return img;
}

test('drawMask Over/Src pixdump matches Go', () => {
  const { extra } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const maskDst = Image.rgba(rect(0, 0, 8, 8));
  const mask = Image.alpha(rect(0, 0, 8, 8));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      maskDst.set(x, y, nrgba({ r: 0, g: 0, b: 255, a: 255 }));
      mask.set(x, y, nrgba({ r: 0, g: 0, b: 0, a: (x + y) * 16 }));
    }
  }
  const src = sampleNRGBA8();
  const over = Image.rgba(rect(0, 0, 8, 8));
  draw(over, rect(0, 0, 8, 8), maskDst, { x: 0, y: 0 }, 'src');
  drawMask(over, rect(0, 0, 8, 8), src, { x: 0, y: 0 }, mask, { x: 0, y: 0 }, 'over');
  assert.equal(pixdump(over), extra.drawMaskOver);
  const srcOp = Image.rgba(rect(0, 0, 8, 8));
  draw(srcOp, rect(0, 0, 8, 8), maskDst, { x: 0, y: 0 }, 'src');
  drawMask(srcOp, rect(0, 0, 8, 8), src, { x: 0, y: 0 }, mask, { x: 0, y: 0 }, 'src');
  assert.equal(pixdump(srcOp), extra.drawMaskSrc);
});

test('FloydSteinberg and Src quantize pixdump/indices match Go', () => {
  const { extra } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const src = gradient16();
  const floyd9 = quantize(plan9Palette(), src, { drawer: 'floyd-steinberg' });
  assert.equal(pixdump(floyd9), extra.floydPlan9);
  assert.equal(Buffer.from(floyd9.pix()).toString('hex'), extra.floydPlan9Pix);
  const floydWeb = quantize(webSafePalette(), src, { drawer: 'floyd-steinberg' });
  assert.equal(pixdump(floydWeb), extra.floydWebSafe);
  assert.equal(Buffer.from(floydWeb.pix()).toString('hex'), extra.floydWebSafePix);
  const src9 = quantize(plan9Palette(), src);
  assert.equal(pixdump(src9), extra.quantSrcPlan9);
  assert.equal(Buffer.from(src9.pix()).toString('hex'), extra.quantSrcPlan9Pix);
});

test('0×0 / 1×0 / 0×1 PNG encode matches Go FormatError', () => {
  for (const [w, h] of [[0, 0], [1, 0], [0, 1]]) {
    const img = Image.nrgba(rect(0, 0, w, h));
    assert.equal(img.width, w);
    assert.equal(img.height, h);
    assert.equal(img.pix().length, 0);
    assert.throws(() => pngEncode(img), PngFormatError);
  }
});

test('1×1 / gray / fully-transparent PNG DecodeConfig+pixdump match Go', () => {
  const { fixtures } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const names = ['bound-1x1.png', 'bound-gray-2x2.png', 'bound-transparent-2x2.png'];
  for (const name of names) {
    const f = fixtures.find((row) => row.name === name);
    assert.ok(f, `missing Go fixture ${name}`);
    const buf = hexToBytes(f.bytesHex);
    const cfg = pngDecodeConfig(buf);
    assert.equal(cfg.width, f.width, name);
    assert.equal(cfg.height, f.height, name);
    assert.equal(cfg.colorModel, f.colorModel, name);
    const img = pngDecode(buf);
    assert.equal(pixdump(img), f.pix, `${name} pixdump`);
    img.dispose();
  }
});

test('every truncated prefix of the Go 1×1 PNG throws PngFormatError', () => {
  const { fixtures } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const f = fixtures.find((row) => row.name === 'bound-1x1.png');
  assert.ok(f);
  const buf = hexToBytes(f.bytesHex);
  assert.ok(buf.length >= 33, 'PNG with IHDR should be longer than 33 bytes');
  for (let n = 0; n < buf.length; n++) {
    const prefix = buf.subarray(0, n);
    assert.throws(
      () => pngDecode(prefix),
      PngFormatError,
      `pngDecode prefix length ${n}/${buf.length} must be PngFormatError`,
    );
  }
  pngDecode(buf);
});

test('Plan9 and WebSafe Index match Go on 1024 random NRGBA colors', () => {
  const { extra } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.ok(extra.plan9IndexRandom.length >= 1000);
  assert.ok(extra.webSafeIndexRandom.length >= 1000);
  const plan9 = plan9Palette();
  const web = webSafePalette();
  for (const row of extra.plan9IndexRandom) {
    assert.equal(plan9.index({ r: row.r, g: row.g, b: row.b, a: row.a }), row.index);
  }
  for (const row of extra.webSafeIndexRandom) {
    assert.equal(web.index({ r: row.r, g: row.g, b: row.b, a: row.a }), row.index);
  }
});
