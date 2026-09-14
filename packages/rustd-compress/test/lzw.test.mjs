import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  lzwCompress, lzwDecompress, LzwCompressor, LzwDecompressor, LzwConfigError, LzwFormatError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/lzw.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures/compress', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20, timeout: 120000,
  });
  if (result.error) throw result.error;
  return result;
}

function hex(data) { return Buffer.from(data).toString('hex'); }

test('Go regenerates committed LZW fixtures; native matches compress and decompress', () => {
  const generated = go(['-pkg', 'lzw']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(fixturePath, 'utf8');
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  assert.equal(generated.stdout, committed, 'Go LZW fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'lzw');
  const widths = new Set();
  const orders = new Set();
  for (const c of packet.lzw) {
    widths.add(c.litWidth);
    orders.add(c.order);
    const opts = { order: c.order, litWidth: c.litWidth };
    const input = Buffer.from(c.inputHex, 'hex');
    const expected = Buffer.from(c.compressedHex, 'hex');
    const compressed = lzwCompress(input, opts);
    assert.equal(hex(compressed), c.compressedHex, `${c.id} compress`);
    assert.equal(hex(lzwDecompress(compressed, opts)), c.inputHex, `${c.id} js-decompress`);
    assert.equal(hex(lzwDecompress(expected, opts)), c.inputHex, `${c.id} go-compressed`);
  }
  assert.deepEqual([...widths].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...orders].sort(), ['lsb', 'msb']);
});

test('JS-generated LZW bytes verify against Go', () => {
  const cases = [];
  for (const order of ['lsb', 'msb']) {
    for (const litWidth of [2, 3, 4, 5, 6, 7, 8]) {
      const max = (1 << litWidth) - 1;
      const input = Uint8Array.from({ length: 300 }, (_, i) => (i * 13 + 5) & max);
      const compressed = lzwCompress(input, { order, litWidth });
      cases.push({
        id: `js-${order}-${litWidth}`,
        order, litWidth,
        inputHex: hex(input),
        compressedHex: hex(compressed),
      });
    }
  }
  const verified = go(['-pkg', 'lzw', '-verify'], JSON.stringify({ schema: 1, package: 'lzw', lzw: cases }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 14 lzw cases/);
});

test('streaming LZW matches one-shot across split points', () => {
  const opts = { order: 'lsb', litWidth: 8 };
  const input = Uint8Array.from({ length: 5000 }, (_, i) => (i * 17) & 255);
  const expected = lzwCompress(input, opts);
  for (const size of [1, 2, 3, 7, 64, 1024, input.length]) {
    const enc = new LzwCompressor(opts);
    for (let i = 0; i < input.length; i += size) enc.write(input.subarray(i, i + size));
    assert.equal(hex(enc.finish()), hex(expected), `compress split ${size}`);
    const dec = new LzwDecompressor(opts);
    for (let i = 0; i < expected.length; i += size) dec.write(expected.subarray(i, i + size));
    dec.end();
    const chunks = [];
    for (;;) {
      const part = dec.read(size === 1 ? 1 : 64);
      if (!part.length) break;
      chunks.push(part);
    }
    const joined = Buffer.concat(chunks);
    assert.equal(hex(joined), hex(input), `decompress split ${size}`);
  }
});

test('litWidth is rejected immediately with Go wording', () => {
  for (const litWidth of [1, 9, 0, -1, 1.5, Number.NaN]) {
    assert.throws(() => lzwCompress(new Uint8Array([0]), { order: 'lsb', litWidth }), LzwConfigError);
    try {
      lzwCompress(new Uint8Array([0]), { order: 'lsb', litWidth });
    } catch (err) {
      if (Number.isInteger(litWidth)) {
        assert.equal(err.message, `lzw: litWidth ${litWidth} out of range`);
      }
    }
  }
});

test('input bytes larger than litWidth fail', () => {
  assert.throws(
    () => lzwCompress(new Uint8Array([4]), { order: 'lsb', litWidth: 2 }),
    (err) => err instanceof LzwConfigError && err.message === 'lzw: input byte too large for the litWidth',
  );
});

test('truncated LZW stream errors without crashing', () => {
  const opts = { order: 'msb', litWidth: 8 };
  const compressed = lzwCompress(Uint8Array.from({ length: 64 }, (_, i) => i), opts);
  assert.throws(() => lzwDecompress(compressed.subarray(0, 1), opts), LzwFormatError);
  const dec = new LzwDecompressor(opts);
  dec.write(compressed.subarray(0, 2));
  assert.throws(() => dec.end(), LzwFormatError);
});

test('typed-array slices are respected and outputs are independent', () => {
  const opts = { order: 'lsb', litWidth: 8 };
  const source = new Uint8Array([9, 1, 2, 3, 9]);
  const compressed = lzwCompress(source.subarray(1, 4), opts);
  const output = lzwDecompress(compressed, opts);
  assert.deepEqual([...output], [1, 2, 3]);
  output[0] = 77;
  assert.equal(source[1], 1);
});
