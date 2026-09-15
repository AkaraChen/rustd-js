import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Image, rect, nrgba, pngEncode, gifEncode, pngDecode, gifDecode } from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const reportPath = join(dir, 'encode-bytes-compare.json');

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

function goEncodeBytes() {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const r = spawnSync(command, [...prefix, 'run', '.', '-encode-bytes'], {
    cwd: join(dir, 'gofixtures'),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GOWORK: 'off', GOTOOLCHAIN: 'go1.25.0' },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`go -encode-bytes failed:\n${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

function hexToBytes(hex) {
  return Buffer.from(hex, 'hex');
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return { offset: i, go: a[i], ts: b[i] };
    }
  }
  if (a.length !== b.length) {
    return { offset: n, go: a.length > n ? a[n] : null, ts: b.length > n ? b[n] : null };
  }
  return null;
}

function pngChunks(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const out = { signatureOk: buf.subarray(0, 8).equals(sig), types: [], ihdr: null, idatCount: 0, idatBytes: 0 };
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('ascii');
    const data = buf.subarray(i + 8, i + 8 + len);
    out.types.push({ type, len });
    if (type === 'IHDR' && data.length >= 13) {
      out.ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    }
    if (type === 'IDAT') {
      out.idatCount += 1;
      out.idatBytes += len;
      if (!out.zlib) {
        out.zlib = { cmf: data[0], flg: data[1] };
      }
    }
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function gifHeader(buf) {
  const packed = buf.length >= 11 ? buf[10] : null;
  return {
    version: buf.subarray(0, 6).toString('ascii'),
    width: buf.length >= 8 ? buf.readUInt16LE(6) : null,
    height: buf.length >= 10 ? buf.readUInt16LE(8) : null,
    packed,
    gctFlag: packed !== null ? Boolean(packed & 0x80) : null,
    colorResolutionBits: packed !== null ? ((packed >> 4) & 7) + 1 : null,
    gctSize: packed !== null && (packed & 0x80) ? 3 * (2 ** ((packed & 7) + 1)) : 0,
  };
}

function compareCase(name, goBuf, tsBuf, extra) {
  const diff = firstDiff(goBuf, tsBuf);
  return {
    name,
    equal: diff === null && goBuf.length === tsBuf.length,
    goLen: goBuf.length,
    tsLen: tsBuf.length,
    firstDiff: diff,
    ...extra,
  };
}

test('PNG NoCompression and GIF NumColors encode bytes vs Go (#19 §4.5 exploration)', () => {
  const go = goEncodeBytes();
  const src = sampleNRGBA8();
  const tsPng = Buffer.from(pngEncode(src, { compressionLevel: -1 }));
  const tsGif256 = Buffer.from(gifEncode(src, { numColors: 256 }));
  const tsGif16 = Buffer.from(gifEncode(src, { numColors: 16 }));
  src.dispose();

  const goPng = hexToBytes(go.pngNoCompressionHex);
  const goGif256 = hexToBytes(go.gifNumColors256Hex);
  const goGif16 = hexToBytes(go.gifNumColors16Hex);

  const pngRound = pngDecode(tsPng);
  const goPngRound = pngDecode(goPng);
  assert.equal(pngRound.width, 8);
  assert.equal(goPngRound.width, 8);
  pngRound.dispose();
  goPngRound.dispose();
  const gifRound = gifDecode(tsGif256);
  const goGifRound = gifDecode(goGif256);
  assert.equal(gifRound.width, 8);
  assert.equal(goGifRound.width, 8);
  gifRound.dispose();
  goGifRound.dispose();

  const png = compareCase('png-NoCompression', goPng, tsPng, {
    goChunks: pngChunks(goPng),
    tsChunks: pngChunks(tsPng),
    note: 'IHDR is identical (8×8, bitDepth 8, colorType 6 RGBA, non-interlaced). zlib CMF/FLG both 0x78 0x01 (no-compression). First mismatch is the IDAT length field (Go 280 vs TS 275) because Go still runs its per-row PNG filter heuristic at NoCompression; the png crate stored-deflate payload is 5 bytes shorter. Go does not promise PNG byte identity.',
  });
  const gif256 = compareCase('gif-NumColors-256', goGif256, tsGif256, {
    goHeader: gifHeader(goGif256),
    tsHeader: gifHeader(tsGif256),
    note: 'Both GIF89a 8×8 with 256-entry GCT (768 bytes). Packed LSD differs: Go 0x87 (colorResolution 1-bit) vs TS 0xf7 (8-bit). Palette is Go median-cut vs rustd-image Plan9 prefix, so LZW stream differs. Not a publish gate.',
  });
  const gif16 = compareCase('gif-NumColors-16', goGif16, tsGif16, {
    goHeader: gifHeader(goGif16),
    tsHeader: gifHeader(tsGif16),
    note: 'Same 101-byte length; first mismatch is packed LSD (Go 0x83 vs TS 0xb3). 16-entry GCT size matches; contents and LZW differ for the same quantizer reason.',
  });

  const report = {
    generatedAt: new Date().toISOString(),
    go: go.go,
    sample: '8x8 NRGBA with (0,0) a=128; same pixels as gofixtures sampleNRGBA',
    issue: '#19 §4.5 exploration (not a publish gate)',
    cases: [png, gif256, gif16],
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  assert.equal(typeof go.pngNoCompressionHex, 'string');
  assert.ok(goPng.length > 0);
  assert.ok(tsPng.length > 0);
  assert.ok(goGif256.length > 0);
  assert.ok(tsGif256.length > 0);
});
