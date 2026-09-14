import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import {
  tarCreate, tarExtract, zipCreate, zipExtract,
  TarReader, ZipReader, TarWriter, ZipWriter,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const GPBF_DATA_DESCRIPTOR = 0x8;

function goCmd() {
  if (process.env.RUSTD_GO === 'path') return { command: 'go', prefix: [] };
  return { command: 'mise', prefix: ['exec', '--', 'go'] };
}

function loadFixtures() {
  const { command, prefix } = goCmd();
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', '-pkg', 'archive'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Go fixtures exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function asU8(buf) {
  return buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
}

function oneByteRead(Reader, buf) {
  const out = [];
  const reader = new Reader();
  reader.on('entry', (e) => out.push(e));
  const u8 = asU8(buf);
  for (let i = 0; i < u8.length; i++) reader.write(u8.subarray(i, i + 1));
  reader.end();
  return out;
}

function tryCall(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return {
      ok: false,
      name: err?.name,
      code: err?.code,
      message: String(err?.message ?? err),
    };
  }
}

function canon(entry) {
  const data = entry.data ?? new Uint8Array();
  const out = {
    name: entry.name,
    type: entry.type,
    typeflag: entry.typeflag,
    size: entry.size,
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid,
    mtime: entry.mtime instanceof Date ? entry.mtime.getTime() : entry.mtime,
    modified: entry.modified instanceof Date ? entry.modified.getTime() : entry.modified,
    linkname: entry.linkname,
    uname: entry.uname,
    gname: entry.gname,
    pax: entry.pax,
    method: entry.method,
    compressedSize: entry.compressedSize,
    crc32: entry.crc32 === undefined ? undefined : entry.crc32 >>> 0,
    comment: entry.comment,
    nonUtf8: entry.nonUtf8,
    rawName: entry.rawName ? Buffer.from(entry.rawName).toString('hex') : undefined,
    dataHex: Buffer.from(data).toString('hex'),
  };
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

function assertNoInvented(got, label) {
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment`);
  assert.equal(got.extra, undefined, `${label} no extra field`);
}

function assertFieldLevel(streamed, whole, label) {
  assert.equal(streamed.length, whole.length, `${label} entry count`);
  assert.equal(Object.hasOwn(streamed, 'comment'), false, `${label} no archive-level comment on stream list`);
  assert.equal(Object.hasOwn(whole, 'comment'), false, `${label} no archive-level comment on extract list`);
  assert.equal(streamed.archiveComment, undefined, `${label} stream list no archiveComment`);
  assert.equal(whole.archiveComment, undefined, `${label} extract list no archiveComment`);
  for (let i = 0; i < whole.length; i++) {
    const tag = `${label}[${i}]`;
    assertNoInvented(whole[i], `${tag} extract`);
    assertNoInvented(streamed[i], `${tag} stream`);
    assert.deepEqual(
      Object.keys(streamed[i]).sort(),
      Object.keys(whole[i]).sort(),
      `${tag} key set`,
    );
    assert.deepEqual(canon(streamed[i]), canon(whole[i]), `${tag} fields+data`);
  }
}

function assertStreamMatchesExtract(kind, buf, label) {
  const Reader = kind === 'tar' ? TarReader : ZipReader;
  const extract = kind === 'tar' ? tarExtract : zipExtract;
  const whole = tryCall(() => extract(asU8(buf)));
  const streamed = tryCall(() => oneByteRead(Reader, buf));
  if (!whole.ok) {
    assert.equal(streamed.ok, false, `${label} stream should throw when extract throws`);
    assert.equal(streamed.name, whole.name, `${label} error name`);
    assert.equal(streamed.code, whole.code, `${label} error code`);
    return;
  }
  assert.equal(streamed.ok, true, `${label} stream threw: ${streamed.message}`);
  assertFieldLevel(streamed.value, whole.value, label);
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function zipDataDescriptor({ name, payload, method = 0, comment = '' }) {
  const flags = GPBF_DATA_DESCRIPTOR | 0x800;
  const crc = zlibCrc32(payload) >>> 0;
  const compressed = method === 8 ? deflateRawSync(payload) : Buffer.from(payload);
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(flags),
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(name.length),
    u16(0),
    Buffer.from(name),
    compressed,
    u32(0x08074b50),
    u32(crc),
    u32(compressed.length),
    u32(payload.length),
  ]);
  const commentBuf = Buffer.from(comment);
  const cd = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(flags),
    u16(method),
    u16(0),
    u16(0),
    u32(crc),
    u32(compressed.length),
    u32(payload.length),
    u16(name.length),
    u16(0),
    u16(commentBuf.length),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    Buffer.from(name),
    commentBuf,
  ]);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(cd.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, cd, eocd]);
}

test('JS tarCreate: TarReader 1-byte write matches tarExtract field-level', () => {
  const long = 'n'.repeat(200);
  const tar = tarCreate([
    {
      name: 'a.txt',
      data: new TextEncoder().encode('hello-stream'),
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      uname: 'user',
      gname: 'group',
      mtime: new Date(1_700_000_000_123),
    },
    { name: 'dir/', type: 'dir', mode: 0o755, mtime: new Date(1_700_000_001_000) },
    { name: 'link', type: 'symlink', linkname: 'a.txt', mode: 0o777 },
    { name: `${long}/deep.txt`, data: new Uint8Array([1, 2, 3, 4]), mode: 0o600 },
    { name: 'empty', data: new Uint8Array() },
  ]);
  assertStreamMatchesExtract('tar', tar, 'js-tarCreate');
});

test('JS zipCreate: ZipReader 1-byte write matches zipExtract field-level', () => {
  const zip = zipCreate([
    { name: 's.txt', method: 0, data: new TextEncoder().encode('store-payload'), comment: 'c1', mode: 0o644 },
    { name: 'd.txt', method: 8, data: new TextEncoder().encode('deflate payload now'), comment: 'c2' },
    { name: 'empty', method: 0, data: new Uint8Array() },
    { name: 'folder/', method: 0, data: new Uint8Array(), mode: 0o755 },
  ]);
  assertStreamMatchesExtract('zip', zip, 'js-zipCreate');
});

test('TarWriter/ZipWriter buffers: 1-byte read matches extract', () => {
  const tw = new TarWriter();
  tw.writeHeader({ name: 'w.txt', data: new TextEncoder().encode('writer'), mode: 0o644 });
  tw.write(new TextEncoder().encode('writer'));
  tw.writeHeader({ name: 'e', data: new Uint8Array() });
  tw.write(new Uint8Array());
  assertStreamMatchesExtract('tar', tw.end(), 'tar-writer');

  const zw = new ZipWriter();
  zw.writeHeader({ name: 'w.txt', method: 8, data: new TextEncoder().encode('writer'), comment: 'zw' });
  zw.write(new TextEncoder().encode('writer'));
  zw.writeHeader({ name: 's.bin', method: 0, data: new Uint8Array([9, 8, 7]) });
  zw.write(new Uint8Array([9, 8, 7]));
  assertStreamMatchesExtract('zip', zw.end(), 'zip-writer');
});

test('Go fixture archives: 1-byte Reader vs extract field-level (issue #2 §4.4)', () => {
  const packet = loadFixtures();
  const tarCases = packet.cases.filter((c) => c.kind === 'tar');
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(tarCases.length >= 10, tarCases.length);
  assert.ok(zipCases.length >= 10, zipCases.length);

  for (const c of tarCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    assertStreamMatchesExtract('tar', raw, c.id);
  }
  for (const c of zipCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    assertStreamMatchesExtract('zip', raw, c.id);
  }
});

test('zip data-descriptor (GPBF bit 3): 1-byte ZipReader vs zipExtract', () => {
  const store = zipDataDescriptor({
    name: 'dd.txt',
    payload: Buffer.from('descriptor-store'),
    method: 0,
    comment: 'entry-note',
  });
  const deflate = zipDataDescriptor({
    name: 'dd.bin',
    payload: Buffer.from('descriptor-deflate-payload'),
    method: 8,
  });
  assertStreamMatchesExtract('zip', store, 'dd-store');
  assertStreamMatchesExtract('zip', deflate, 'dd-deflate');
});
