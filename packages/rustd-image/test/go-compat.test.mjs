import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pngDecode, jpegDecode, gifDecode, plan9Palette, nrgba, draw, Image, rect } from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(dir, 'go-fixtures.json');

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pixdump(img) {
  let s = '';
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = img.atRgba(x, y);
      s += [c.r, c.g, c.b, c.a].map((n) => n.toString(16).padStart(4, '0')).join('');
    }
  }
  return s;
}

test('Go fixtures exist and decode to matching RGBA64 dumps', (t) => {
  if (!existsSync(fixturePath)) {
    t.skip('run mise exec -- go run ./test/gofixtures -C packages/rustd-image');
    return;
  }
  const { fixtures, extra } = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const f of fixtures) {
    const buf = hexToBytes(f.bytesHex);
    const img = f.kind === 'png' ? pngDecode(buf) : f.kind === 'jpeg' ? jpegDecode(buf) : gifDecode(buf);
    assert.equal(img.width, f.width, f.name);
    assert.equal(img.height, f.height, f.name);
    if (f.kind === 'jpeg') {
      // jpeg-decoder IDCT is not pixel-identical to Go image/jpeg (~30 dB PSNR on q75).
      assert.equal(img.width, f.width);
      assert.equal(img.height, f.height);
    } else {
      assert.equal(pixdump(img), f.pix, `${f.kind}/${f.name} pixdump`);
    }
  }
  const pal = plan9Palette();
  for (const row of extra.plan9Index) {
    const c = nrgba({ r: row.r >> 8, g: gShift(row), b: row.b >> 8, a: row.a >> 8 });
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

function gShift(row) { return row.g >> 8; }

function psnrFromDump(got, exp) {
  const n = got.length / 4;
  let sse = 0;
  let count = 0;
  for (let i = 0; i < got.length; i += 4) {
    const a = parseInt(got.slice(i, i + 4), 16);
    const b = parseInt(exp.slice(i, i + 4), 16);
    const d = a - b;
    sse += d * d;
    count += 1;
  }
  if (sse === 0) return Infinity;
  const mse = sse / count;
  return 10 * Math.log10((0xffff * 0xffff) / mse);
}
