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
  for (const c of packet.bzip) decodeCase(c);
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

test('bzip2DecompressStream yields the same bytes', async () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const happy = packet.bzip.find((c) => c.id === 'lcg4k-9');
  const data = Buffer.from(happy.compressedB64, 'base64');
  async function* chunks() {
    yield data.subarray(0, 10);
    yield data.subarray(10);
  }
  const out = [];
  for await (const part of bzip2DecompressStream(chunks())) out.push(part);
  assert.equal(sha(Buffer.concat(out)), happy.sha256);
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

test('outputs are independent copies', () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const happy = packet.bzip.find((c) => c.id === 'hello-9');
  const data = new Uint8Array(Buffer.from(happy.compressedB64, 'base64'));
  const out = bzip2Decompress(data);
  out[0] = 0;
  const again = bzip2Decompress(data);
  assert.equal(sha(again), happy.sha256);
});
