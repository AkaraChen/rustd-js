import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  tarCreate, tarExtract, zipCreate, zipExtract,
  TarReader, TarWriter, ZipReader, ZipWriter,
  TarFormatError, ZipFormatError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
function go(args, input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const prefix = command === 'go' ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', ...args], {
    cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Go exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function loadFixtures() {
  return JSON.parse(go(['-pkg', 'archive']));
}

function equalBytes(a, b) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
}

test('Go fixtures: native reads tar/zip fields and data', () => {
  const packet = loadFixtures();
  assert.ok(packet.cases.length >= 30, packet.cases.length);
  for (const c of packet.cases) {
    const raw = Uint8Array.from(Buffer.from(c.archiveHex, 'hex'));
    const wantEntries = c.entries ?? [];
    if (c.kind === 'tar') {
      const got = tarExtract(raw);
      assert.equal(got.length, wantEntries.length, c.id);
      for (let i = 0; i < got.length; i++) {
        const want = wantEntries[i];
        assert.equal(got[i].name, want.name, `${c.id} name`);
        if (want.type && got[i].type !== 'x-global-header') {
          assert.equal(got[i].type, want.type, `${c.id} type`);
        }
        const data = Buffer.from(want.dataHex, 'hex');
        equalBytes(got[i].data, data);
      }
    } else {
      const got = zipExtract(raw);
      assert.equal(got.length, wantEntries.length, c.id);
      for (let i = 0; i < got.length; i++) {
        const want = wantEntries[i];
        assert.equal(got[i].name, want.name, `${c.id} name`);
        equalBytes(got[i].data, Buffer.from(want.dataHex, 'hex'));
      }
    }
  }
});

test('JS archives round-trip through Go', () => {
  const cases = [];
  const tar = tarCreate([
    { name: 'a.txt', data: new Uint8Array([9, 8, 7]), mode: 0o644, mtime: new Date(1_700_000_000_000) },
    { name: 'dir/', type: 'dir', mode: 0o755, mtime: new Date(1_700_000_000_000) },
    { name: 'dir/b.txt', data: new TextEncoder().encode('bee'), mtime: new Date(1_700_000_000_000) },
    { name: `${'n'.repeat(120)}.txt`, data: new Uint8Array([1]), mtime: new Date(1_700_000_000_000) },
  ]);
  cases.push({
    id: 'js-tar', kind: 'tar', archiveHex: Buffer.from(tar).toString('hex'),
    entries: tarExtract(tar).map(e => ({ name: e.name, dataHex: Buffer.from(e.data).toString('hex') })),
  });
  const zip = zipCreate([
    { name: 's.txt', method: 0, data: new TextEncoder().encode('store') },
    { name: 'd.txt', method: 8, data: new TextEncoder().encode('deflate payload') },
    { name: 'folder/', method: 0, data: new Uint8Array() },
  ]);
  cases.push({
    id: 'js-zip', kind: 'zip', archiveHex: Buffer.from(zip).toString('hex'),
    entries: zipExtract(zip).map(e => ({ name: e.name, dataHex: Buffer.from(e.data).toString('hex') })),
  });
  const out = go(['-pkg', 'archive', '-verify'], JSON.stringify({ schema: 1, package: 'archive', cases }));
  assert.match(out, /Go verified 2 archive cases/);
});

test('streaming tar/zip matches whole-buffer extract', () => {
  const tar = tarCreate([
    { name: 'one', data: new Uint8Array(200).fill(7) },
    { name: 'two', data: new TextEncoder().encode('stream') },
  ]);
  const chunked = [];
  const reader = new TarReader();
  reader.on('entry', e => chunked.push(e));
  for (let i = 0; i < tar.length; i += 17) reader.write(tar.subarray(i, i + 17));
  reader.end();
  const whole = tarExtract(tar);
  assert.equal(chunked.length, whole.length);
  for (let i = 0; i < whole.length; i++) {
    assert.equal(chunked[i].name, whole[i].name);
    equalBytes(chunked[i].data, whole[i].data);
  }
  const zip = zipCreate([{ name: 'z', method: 8, data: new Uint8Array(300).fill(3) }]);
  const zgot = [];
  const zr = new ZipReader();
  zr.on('entry', e => zgot.push(e));
  for (let i = 0; i < zip.length; i += 11) zr.write(zip.subarray(i, i + 11));
  zr.end();
  const zwhole = zipExtract(zip);
  assert.equal(zgot.length, zwhole.length);
  equalBytes(zgot[0].data, zwhole[0].data);
});

test('TarWriter/ZipWriter match create()', () => {
  const entries = [
    { name: 'w.txt', data: new TextEncoder().encode('writer'), size: 6, mode: 0o644 },
  ];
  const w = new TarWriter();
  w.writeHeader(entries[0]);
  w.write(entries[0].data);
  const fromWriter = tarExtract(w.end());
  const fromCreate = tarExtract(tarCreate(entries));
  assert.equal(fromWriter[0].name, fromCreate[0].name);
  equalBytes(fromWriter[0].data, fromCreate[0].data);
  const zw = new ZipWriter();
  zw.writeHeader({ name: 'w.txt', method: 8, data: entries[0].data, size: 6 });
  zw.write(entries[0].data);
  equalBytes(zipExtract(zw.end())[0].data, entries[0].data);
});

test('truncated archives throw format errors, never hang', () => {
  const tar = tarCreate([{ name: 't', data: new Uint8Array([1, 2, 3, 4]) }]);
  for (let n = 1; n < tar.length; n++) {
    assert.throws(() => tarExtract(tar.subarray(0, n)), TarFormatError);
  }
  const zip = zipCreate([{ name: 't', method: 0, data: new Uint8Array([1, 2, 3, 4]) }]);
  let throws = 0;
  for (let n = 1; n < zip.length; n++) {
    try { zipExtract(zip.subarray(0, n)); } catch (e) {
      assert.ok(e instanceof ZipFormatError, n);
      throws++;
    }
  }
  assert.ok(throws > 0);
});

test('zip central-directory offset past EOF is a ZipFormatError', () => {
  const zip = zipCreate([{ name: 't', method: 0, data: new Uint8Array([1]) }]);
  const evil = new Uint8Array(zip);
  // EOCD cd offset is 16 bytes from EOCD start; last 22 bytes are EOCD (empty comment).
  const eocd = evil.length - 22;
  evil[eocd + 16] = 0xff; evil[eocd + 17] = 0xff; evil[eocd + 18] = 0xff; evil[eocd + 19] = 0x7f;
  assert.throws(() => zipExtract(evil), ZipFormatError);
});

test('empty input and typed-array slices', () => {
  assert.throws(() => tarExtract(new Uint8Array()), TarFormatError);
  assert.throws(() => zipExtract(new Uint8Array()), ZipFormatError);
  const src = new Uint8Array([9, 1, 2, 9]);
  const tar = tarCreate([{ name: 's', data: src.subarray(1, 3) }]);
  const got = tarExtract(tar)[0].data;
  equalBytes(got, new Uint8Array([1, 2]));
  got[0] = 77;
  assert.equal(src[1], 1);
});
