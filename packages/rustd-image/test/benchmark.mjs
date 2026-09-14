import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpegDecode, jpegEncode, pngDecode, pngEncode } from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
const reference = spawnSync(command, [...prefix, 'run', '.', '-bench'], {
  cwd: resolve(dir, 'gofixtures'),
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, GOTOOLCHAIN: 'go1.25.0', GOMAXPROCS: '1', GOWORK: 'off' },
});
if (reference.error) throw reference.error;
if (reference.status !== 0) {
  throw new Error(reference.stderr || `go bench exited ${reference.status}`);
}
const go = JSON.parse(reference.stdout);
const pngBytes = hexToBytes(go.pngHex);
const jpegBytes = hexToBytes(go.jpegHex);
const { width, height, iters } = go;

pngDecode(pngBytes).dispose();
jpegDecode(jpegBytes).dispose();
const src = pngDecode(pngBytes);
pngEncode(src);
jpegEncode(src);

const pngDecodeMs = timeIters(iters, () => {
  pngDecode(pngBytes).dispose();
});
const jpegDecodeMs = timeIters(iters, () => {
  jpegDecode(jpegBytes).dispose();
});
const pngEncodeMs = timeIters(iters, () => {
  pngEncode(src);
});
const jpegEncodeMs = timeIters(iters, () => {
  jpegEncode(src);
});
src.dispose();

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timeIters(n, fn) {
  const start = performance.now();
  for (let i = 0; i < n; i++) fn();
  return performance.now() - start;
}

function mpix(ms) {
  return (width * height * iters) / (ms * 1e3);
}

function row(op, nativeMs, goMs) {
  const nativeMpix = mpix(nativeMs);
  const goMpix = mpix(goMs);
  return {
    op,
    nativeMs: round(nativeMs),
    goMs: round(goMs),
    nativeMpixS: round(nativeMpix, 2),
    goMpixS: round(goMpix, 2),
    pctOfGo: Math.round((goMs / nativeMs) * 100),
  };
}

function round(n, digits = 1) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

const rows = [
  row('pngDecode', pngDecodeMs, go.pngDecodeMs),
  row('jpegDecode', jpegDecodeMs, go.jpegDecodeMs),
  row('pngEncode', pngEncodeMs, go.pngEncodeMs),
  row('jpegEncode', jpegEncodeMs, go.jpegEncodeMs),
];
const result = {
  date: new Date().toISOString().slice(0, 10),
  node: process.version,
  go: go.go,
  platform: `${process.platform}-${process.arch}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  width,
  height,
  iters,
  pngBytes: go.pngBytes,
  jpegBytes: go.jpegBytes,
  method:
    'One sequential pass, 512×512 seeded-random NRGBA, 8 iterations, GOMAXPROCS=1; shared host, not an isolated benchmark.',
  decodeFloorPct: 60,
  rows,
};
writeFileSync(resolve(dir, 'benchmark-results.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
