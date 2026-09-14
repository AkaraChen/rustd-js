import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  pngDecode, pngDecodeConfig, jpegDecodeConfig, gifDecode, gifDecodeAll, gifDecodeConfig,
  plan9Palette, nrgba, draw, Image, rect,
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
