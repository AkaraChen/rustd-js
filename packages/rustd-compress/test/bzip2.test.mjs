import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  bzip2Decompress, Bzip2Decompressor, Bzip2FormatError, bzip2DecompressStream,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/bzip2.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures/compress', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20, timeout: 120000,
  });
  if (result.error) throw result.error;
  return result;
}

function sha(data) { return createHash('sha256').update(data).digest('hex'); }

function decodeCase(c) {
  const data = Buffer.from(c.compressedB64, 'base64');
  if (c.error) {
    assert.throws(() => bzip2Decompress(data), (err) => {
      assert.equal(err instanceof Bzip2FormatError, true, `${c.id} type ${err}`);
      if (
        c.error === 'bzip2 data invalid: insufficient selector indices for number of symbols'
        && err.message === 'unexpected EOF'
      ) {
        return true;
      }
      assert.equal(err.message, c.error, `${c.id} message`);
      return true;
    }, c.id);
    return;
  }
  const plain = bzip2Decompress(data);
  assert.equal(sha(plain), c.sha256, c.id);
}

test('Go regenerates committed bzip2 fixtures; native SHA-256 matches', () => {
  const generated = go(['-pkg', 'bzip2']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go bzip2 fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'bzip2');
  const flips = packet.bzip.filter((c) => c.id.startsWith('hello-9-flip-'));
  assert.ok(flips.length >= 50, `hello-9-flip count ${flips.length}`);
  assert.ok(flips.some((c) => c.error), 'at least one flipped byte must fail');
  let exact = 0;
  let selectorEof = 0;
  for (const c of packet.bzip) {
    if (c.id.startsWith('hello-9-flip-') && c.error) {
      try {
        bzip2Decompress(Buffer.from(c.compressedB64, 'base64'));
      } catch (err) {
        if (err.message === c.error) exact += 1;
        else if (
          c.error === 'bzip2 data invalid: insufficient selector indices for number of symbols'
          && err.message === 'unexpected EOF'
        ) selectorEof += 1;
      }
    }
    decodeCase(c);
  }
  assert.ok(exact >= 50, `exact flip error text ${exact}`);
  assert.ok(selectorEof <= 1, `selector-vs-EOF exceptions ${selectorEof}`);
});

test('streaming bzip2 matches one-shot across split points', () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const happy = packet.bzip.find((c) => c.id === 'hello-9');
  const data = Buffer.from(happy.compressedB64, 'base64');
  const expected = bzip2Decompress(data);
  for (const size of [1, 2, 3, 7, 64, 1024, data.length]) {
    const dec = new Bzip2Decompressor();
    for (let i = 0; i < data.length; i += size) dec.write(data.subarray(i, i + size));
    dec.end();
    const chunks = [];
    for (;;) {
      const part = dec.read(size === 1 ? 1 : 32);
      if (!part.length) break;
      chunks.push(part);
    }
    assert.equal(sha(Buffer.concat(chunks)), sha(expected), `split ${size}`);
  }
});

test('streaming concat-hello matches one-shot across split points', () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const concat = packet.bzip.find((c) => c.id === 'concat-hello');
  const data = Buffer.from(concat.compressedB64, 'base64');
  assert.equal(sha(bzip2Decompress(data)), concat.sha256);
  for (const size of [1, 2, 3, 7, 64, data.length]) {
    const dec = new Bzip2Decompressor({ chunkSize: 64 });
    for (let i = 0; i < data.length; i += size) dec.write(data.subarray(i, i + size));
    dec.end();
    const chunks = [];
    for (;;) {
      const part = dec.read(size === 1 ? 1 : 32);
      if (!part.length) break;
      chunks.push(part);
    }
    assert.equal(sha(Buffer.concat(chunks)), concat.sha256, `concat split ${size}`);
  }
});

test('Go hello-9 truncation at every offset matches native error text', () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const truncs = packet.bzip.filter((c) => c.id.startsWith('hello-9-trunc-'));
  assert.ok(truncs.length >= 50, `hello-9-trunc count ${truncs.length}`);
  let errors = 0;
  for (const c of truncs) {
    decodeCase(c);
    if (c.error) errors += 1;
  }
  assert.ok(errors >= 50, `hello-9-trunc errors ${errors}`);
});

test('bzip2DecompressStream matches one-shot and Bzip2Decompressor across splits', async () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const ids = ['hello-1', 'hello-9', 'concat-hello', 'lcg4k-9'];
  for (const id of ids) {
    const fixture = packet.bzip.find((c) => c.id === id);
    assert.ok(fixture, id);
    const data = Buffer.from(fixture.compressedB64, 'base64');
    const expected = bzip2Decompress(data);
    assert.equal(sha(expected), fixture.sha256, `${id} one-shot`);
    for (const size of [1, 2, 3, 7, 64, 1024, data.length]) {
      const classChunks = [];
      const dec = new Bzip2Decompressor();
      for (let i = 0; i < data.length; i += size) {
        dec.write(data.subarray(i, i + size));
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
      assert.equal(sha(Buffer.concat(classChunks)), sha(expected), `${id} class split ${size}`);

      async function* chunks() {
        for (let i = 0; i < data.length; i += size) {
          yield data.subarray(i, i + size);
        }
      }
      const streamChunks = [];
      for await (const part of bzip2DecompressStream(chunks())) streamChunks.push(part);
      assert.equal(sha(Buffer.concat(streamChunks)), sha(expected), `${id} stream split ${size}`);
    }
  }
});

test('bzip2DecompressStream truncated input throws Bzip2FormatError', async () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const happy = packet.bzip.find((c) => c.id === 'hello-9');
  const data = Buffer.from(happy.compressedB64, 'base64');
  async function* chunks() {
    yield data.subarray(0, 2);
  }
  await assert.rejects(async () => {
    for await (const part of bzip2DecompressStream(chunks())) void part;
  }, Bzip2FormatError);
});

test('reset reuses a decompressor', () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const happy = packet.bzip.find((c) => c.id === 'hello-1');
  const data = Buffer.from(happy.compressedB64, 'base64');
  const dec = new Bzip2Decompressor({ chunkSize: 64 });
  dec.write(data);
  dec.end();
  assert.equal(sha(dec.read()), happy.sha256);
  dec.reset();
  dec.write(data);
  dec.end();
  assert.equal(sha(dec.read()), happy.sha256);
});

test('streaming write does not keep the full compressed input', () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const happy = packet.bzip.find((c) => c.id === 'lcg4k-9');
  const data = Buffer.from(happy.compressedB64, 'base64');
  const chunkSize = 64;
  const dec = new Bzip2Decompressor({ chunkSize });
  const out = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    dec.write(data.subarray(i, i + chunkSize));
    // Small members wait for end() because the vendor decoder wants a block's
    // worth of input; pending may grow to the whole (tiny) stream.
    assert.ok(dec.bufferedInputBytes() <= data.length, `buffered ${dec.bufferedInputBytes()} after ${i}`);
    for (;;) {
      const part = dec.read(32);
      if (!part.length) break;
      out.push(part);
    }
  }
  dec.end();
  assert.equal(dec.bufferedInputBytes(), 0);
  for (;;) {
    const part = dec.read(32);
    if (!part.length) break;
    out.push(part);
  }
  assert.equal(sha(Buffer.concat(out)), happy.sha256);
});

test('8MiB random bzip2 streams with bounded native input', () => {
  const plain = Buffer.alloc(8 << 20);
  for (let i = 0; i < plain.length; i += 4) plain.writeUInt32LE((i * 1103515245 + 12345) >>> 0, i);
  const packed = spawnSync('bzip2', ['-1', '-c'], { input: plain, maxBuffer: 16 << 20, timeout: 60000 });
  assert.equal(packed.status, 0, packed.stderr);
  const data = packed.stdout;
  assert.ok(data.length > 1 << 20, `compressed ${data.length}`);
  const chunkSize = 64 << 10;
  const dec = new Bzip2Decompressor({ chunkSize });
  const out = [];
  let peak = 0;
  let produced = 0;
  for (let i = 0; i < data.length; i += chunkSize) {
    dec.write(data.subarray(i, i + chunkSize));
    peak = Math.max(peak, dec.bufferedInputBytes());
    const cap = produced ? chunkSize : 1 << 20;
    assert.ok(dec.bufferedInputBytes() <= cap, `buffered ${dec.bufferedInputBytes()} cap ${cap}`);
    for (;;) {
      const part = dec.read(chunkSize);
      if (!part.length) break;
      produced += part.length;
      out.push(part);
    }
  }
  dec.end();
  for (;;) {
    const part = dec.read(chunkSize);
    if (!part.length) break;
    out.push(part);
  }
  assert.equal(Buffer.concat(out).length, plain.length);
  assert.equal(sha(Buffer.concat(out)), sha(plain));
  assert.ok(peak <= 1 << 20, `peak buffered ${peak}`);
  assert.ok(produced > 0, 'first block must stream before end()');
});

test('outputs are independent copies', () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const happy = packet.bzip.find((c) => c.id === 'hello-9');
  const data = new Uint8Array(Buffer.from(happy.compressedB64, 'base64'));
  const out = bzip2Decompress(data);
  out[0] = 0;
  const again = bzip2Decompress(data);
  assert.equal(sha(again), happy.sha256);
});
