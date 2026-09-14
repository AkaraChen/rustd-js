import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  lzwCompress, lzwDecompress, lzwCompressStream, lzwDecompressStream, LzwCompressor, LzwDecompressor, LzwConfigError, LzwFormatError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/lzw.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures/compress', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 64 << 20, timeout: 180000,
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
    const chunks = [];
    let produced = 0;
    for (let i = 0; i < expected.length; i += size) {
      dec.write(expected.subarray(i, i + size));
      assert.ok(dec.bufferedInputBytes() <= 4, `pending ${dec.bufferedInputBytes()} split ${size} at ${i}`);
      for (;;) {
        const part = dec.read(size === 1 ? 1 : 64);
        if (!part.length) break;
        produced += part.length;
        chunks.push(part);
      }
    }
    assert.ok(produced > 0, `must emit before end() split ${size}`);
    dec.end();
    assert.equal(dec.bufferedInputBytes(), 0);
    for (;;) {
      const part = dec.read(size === 1 ? 1 : 64);
      if (!part.length) break;
      chunks.push(part);
    }
    const joined = Buffer.concat(chunks);
    assert.equal(hex(joined), hex(input), `decompress split ${size}`);
  }
});

test('LZW leftover bits across every byte split match Go for lsb and msb', () => {
  const input = Uint8Array.from({ length: 80 }, (_, i) => (i * 19) & 255);
  for (const order of ['lsb', 'msb']) {
    for (const litWidth of [2, 8]) {
      const max = (1 << litWidth) - 1;
      const plain = Uint8Array.from(input, (b) => b & max);
      const opts = { order, litWidth };
      const compressed = lzwCompress(plain, opts);
      assert.ok(compressed.length >= 3, `${order}-${litWidth} compressed`);
      for (let split = 1; split < compressed.length; split++) {
        const dec = new LzwDecompressor(opts);
        dec.write(compressed.subarray(0, split));
        assert.ok(dec.bufferedInputBytes() <= 4, `${order}-${litWidth} pending at ${split}`);
        const head = [];
        for (;;) {
          const part = dec.read(32);
          if (!part.length) break;
          head.push(part);
        }
        dec.write(compressed.subarray(split));
        dec.end();
        const tail = [];
        for (;;) {
          const part = dec.read(32);
          if (!part.length) break;
          tail.push(part);
        }
        const joined = Buffer.concat([...head, ...tail]);
        assert.equal(hex(joined), hex(plain), `${order}-${litWidth} split ${split}/${compressed.length}`);
      }
    }
  }
});

test('LzwDecompressor.write does not keep the whole compressed stream', () => {
  const opts = { order: 'msb', litWidth: 8 };
  const input = lcg(64 << 10, 7);
  const compressed = lzwCompress(input, opts);
  const dec = new LzwDecompressor(opts);
  const out = [];
  let peak = 0;
  let produced = 0;
  const chunkSize = 1;
  for (let i = 0; i < compressed.length; i += chunkSize) {
    dec.write(compressed.subarray(i, i + chunkSize));
    peak = Math.max(peak, dec.bufferedInputBytes());
    assert.ok(dec.bufferedInputBytes() <= 4, `pending ${dec.bufferedInputBytes()} at ${i}`);
    const part = dec.read();
    if (part.length) {
      produced += part.length;
      out.push(part);
    }
  }
  assert.ok(produced > 0, 'must emit before end()');
  dec.end();
  assert.equal(dec.bufferedInputBytes(), 0);
  const last = dec.read();
  if (last.length) out.push(last);
  assert.equal(hex(Buffer.concat(out)), hex(input));
  assert.ok(peak <= 4, `peak pending ${peak}`);
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

test('Go regenerates LZW truncation/corrupt fixtures; native error text matches', () => {
  const errorFixturePath = new URL('./fixtures/lzw-errors.json', import.meta.url);
  const generated = go(['-pkg', 'lzw-errors']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(errorFixturePath, generated.stdout);
  const committed = readFileSync(errorFixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go LZW error fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'lzw-errors');
  assert.ok(packet.lzwErrors.length >= 40, packet.lzwErrors.length);
  let trunc = 0;
  let truncEof = 0;
  for (const c of packet.lzwErrors) {
    const opts = { order: c.order, litWidth: c.litWidth };
    const data = Buffer.from(c.compressedHex, 'hex');
    if (c.error) {
      assert.throws(() => lzwDecompress(data, opts), (err) => {
        assert.equal(err instanceof LzwFormatError, true, `${c.id} type ${err}`);
        assert.equal(err.message, c.error, `${c.id} message`);
        return true;
      }, c.id);
      if (c.id.includes('-trunc-') || c.id.endsWith('-empty')) {
        trunc += 1;
        if (c.error === 'unexpected EOF') truncEof += 1;
      }
    } else {
      assert.equal(hex(lzwDecompress(data, opts)), c.plainHex ?? '', c.id);
    }
  }
  assert.ok(trunc >= 2, trunc);
  assert.equal(truncEof, trunc, 'every truncation/empty case must be unexpected EOF');
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

function lcg(n, seed) {
  const data = Buffer.alloc(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    data[i] = (state >>> 24) & 0xff;
  }
  return data;
}

test('1MiB LZW matches Go compress and round-trips for all litWidth × order', () => {
  const raw = lcg(1 << 20, 42);
  for (const litWidth of [2, 3, 4, 5, 6, 7, 8]) {
    const max = (1 << litWidth) - 1;
    const input = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) input[i] = raw[i] & max;
    const cases = [];
    for (const order of ['lsb', 'msb']) {
      const opts = { order, litWidth };
      const compressed = lzwCompress(input, opts);
      assert.equal(hex(lzwDecompress(compressed, opts)), hex(input), `${order}-${litWidth} js roundtrip`);
      cases.push({
        id: `js-1mib-${order}-${litWidth}`,
        order,
        litWidth,
        inputHex: hex(input),
        compressedHex: hex(compressed),
      });
    }
    const verified = go(['-pkg', 'lzw', '-verify'], JSON.stringify({ schema: 1, package: 'lzw', lzw: cases }));
    assert.equal(verified.status, 0, `${litWidth}: ${verified.stderr}\n${verified.stdout}`);
    assert.match(verified.stdout, /Go verified 2 lzw cases/);
  }
});

test('lzwCompressStream matches one-shot and LzwCompressor across splits', async () => {
  const input = Uint8Array.from({ length: 2048 }, (_, i) => (i * 3) & 255);
  for (const order of ['lsb', 'msb']) {
    for (const litWidth of [2, 8]) {
      const max = (1 << litWidth) - 1;
      const plain = Uint8Array.from(input, (b) => b & max);
      const opts = { order, litWidth };
      const expected = lzwCompress(plain, opts);
      for (const size of [1, 2, 3, 7, 64, 1024, plain.length]) {
        const enc = new LzwCompressor(opts);
        for (let i = 0; i < plain.length; i += size) enc.write(plain.subarray(i, i + size));
        assert.equal(hex(enc.finish()), hex(expected), `${order}-${litWidth} class split ${size}`);

        async function* chunks() {
          for (let i = 0; i < plain.length; i += size) {
            yield plain.subarray(i, i + size);
          }
        }
        const out = [];
        for await (const part of lzwCompressStream(chunks(), opts)) out.push(part);
        assert.equal(hex(Buffer.concat(out)), hex(expected), `${order}-${litWidth} stream split ${size}`);
      }
    }
  }
});

test('lzwCompressStream empty iterable matches one-shot empty', async () => {
  for (const order of ['lsb', 'msb']) {
    const opts = { order, litWidth: 8 };
    const expected = lzwCompress(new Uint8Array(), opts);
    async function* chunks() {}
    const out = [];
    for await (const part of lzwCompressStream(chunks(), opts)) out.push(part);
    assert.equal(hex(Buffer.concat(out)), hex(expected), order);
  }
});

test('lzwDecompressStream matches one-shot and LzwDecompressor across splits', async () => {
  const input = Uint8Array.from({ length: 5000 }, (_, i) => (i * 17) & 255);
  for (const order of ['lsb', 'msb']) {
    const opts = { order, litWidth: 8 };
    const compressed = lzwCompress(input, opts);
    const expected = lzwDecompress(compressed, opts);
    for (const size of [1, 2, 3, 7, 64, 1024, compressed.length]) {
      const classChunks = [];
      const dec = new LzwDecompressor(opts);
      for (let i = 0; i < compressed.length; i += size) {
        dec.write(compressed.subarray(i, i + size));
        for (;;) {
          const part = dec.read();
          if (!part.length) break;
          classChunks.push(part);
        }
      }
      dec.end();
      for (;;) {
        const part = dec.read();
        if (!part.length) break;
        classChunks.push(part);
      }
      assert.equal(hex(Buffer.concat(classChunks)), hex(expected), `${order} class split ${size}`);

      async function* chunks() {
        for (let i = 0; i < compressed.length; i += size) {
          yield compressed.subarray(i, i + size);
        }
      }
      const streamChunks = [];
      for await (const part of lzwDecompressStream(chunks(), opts)) streamChunks.push(part);
      assert.equal(hex(Buffer.concat(streamChunks)), hex(expected), `${order} stream split ${size}`);
    }
  }
});

test('lzwDecompressStream truncated input throws LzwFormatError', async () => {
  const opts = { order: 'msb', litWidth: 8 };
  const compressed = lzwCompress(Uint8Array.from({ length: 64 }, (_, i) => i), opts);
  async function* chunks() {
    yield compressed.subarray(0, 2);
  }
  await assert.rejects(async () => {
    for await (const part of lzwDecompressStream(chunks(), opts)) void part;
  }, LzwFormatError);
});
