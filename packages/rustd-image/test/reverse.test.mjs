import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  Image, rect, nrgba,
  pngEncode, jpegEncode, gifEncode, gifDecode,
} from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const PNG_LEVELS = [0, -1, -2, -3];
const JPEG_PSNR_MIN = 40;

function pixdump(img) {
  let s = '';
  const out = { r: 0, g: 0, b: 0, a: 0 };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = img.atRgba(x, y, out);
      s += [c.r, c.g, c.b, c.a].map((n) => n.toString(16).padStart(4, '0')).join('');
    }
  }
  return s;
}

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

function jpegSample() {
  // 16×16 tiles align with 4:2:0 MCUs; quality 75 is above 40 dB on this pattern.
  const img = Image.nrgba(rect(0, 0, 64, 64));
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      img.set(x, y, nrgba({
        r: (x >> 4) * 64,
        g: (y >> 4) * 64,
        b: 160,
        a: 255,
      }));
    }
  }
  return img;
}

function goDecode(kind, bytes) {
  const tmp = mkdtempSync(join(tmpdir(), 'rustd-image-rev-'));
  const file = join(tmp, `in.${kind}`);
  writeFileSync(file, bytes);
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const r = spawnSync(command, [...prefix, 'run', '.', '-decode', kind, file], {
    cwd: join(dir, 'gofixtures'),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GOWORK: 'off', GOTOOLCHAIN: 'go1.25.0' },
  });
  rmSync(tmp, { recursive: true, force: true });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`go -decode ${kind} failed:\n${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

function psnrRgb8(pixA, pixB) {
  assert.equal(pixA.length, pixB.length);
  assert.equal(pixA.length % 16, 0);
  let sse = 0;
  let n = 0;
  for (let i = 0; i < pixA.length; i += 16) {
    for (let c = 0; c < 3; c++) {
      const a = parseInt(pixA.slice(i + c * 4, i + c * 4 + 4), 16) >> 8;
      const b = parseInt(pixB.slice(i + c * 4, i + c * 4 + 4), 16) >> 8;
      const d = a - b;
      sse += d * d;
      n += 1;
    }
  }
  if (sse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / (sse / n));
}

test('TS pngEncode four CompressionLevels → Go png.Decode pixdump matches source (#19 §4.2)', () => {
  const src = sampleNRGBA8();
  const orig = pixdump(src);
  for (const level of PNG_LEVELS) {
    const encoded = pngEncode(src, { compressionLevel: level });
    const go = goDecode('png', encoded);
    assert.equal(go.width, 8, `level ${level} width`);
    assert.equal(go.height, 8, `level ${level} height`);
    assert.equal(go.pix, orig, `level ${level} pixdump`);
  }
  src.dispose();
});

test('TS jpegEncode → Go jpeg.Decode PSNR ≥ 40 dB vs source; not pixel-identical (#19 §4.2)', () => {
  const src = jpegSample();
  const orig = pixdump(src);
  const encoded = jpegEncode(src, { quality: 75 });
  const go = goDecode('jpeg', encoded);
  assert.equal(go.width, 64);
  assert.equal(go.height, 64);
  const db = psnrRgb8(orig, go.pix);
  assert.ok(db >= JPEG_PSNR_MIN, `PSNR ${db} dB vs source after Go jpeg.Decode, want ≥ ${JPEG_PSNR_MIN}`);
  assert.notEqual(go.pix, orig, 'JPEG must not be treated as lossless pixdump');
  src.dispose();
});

test('TS gifEncode → Go gif.Decode pixdump matches TS gifDecode (#19 §4.2)', () => {
  const src = sampleNRGBA8();
  const encoded = gifEncode(src, { numColors: 256 });
  src.dispose();
  const tsDec = gifDecode(encoded);
  const go = goDecode('gif', encoded);
  assert.equal(go.width, tsDec.width);
  assert.equal(go.height, tsDec.height);
  assert.equal(go.pix, pixdump(tsDec));
  tsDec.dispose();
});
