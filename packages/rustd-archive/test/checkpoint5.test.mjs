import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  tarCreate, tarExtract, zipExtract,
  TarReader, TarFormatError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const BLOCK = 512;

function go(args, input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const prefix = command === 'go' ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', ...args], {
    cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Go exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function equalBytes(a, b, label) {
  assert.equal(a.length, b.length, label);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `${label}[${i}]`);
}

function octalField(width, value) {
  const s = value.toString(8);
  const buf = Buffer.alloc(width, 0);
  const start = width - s.length - 1;
  buf.fill(0x30, 0, start);
  buf.write(s, start);
  buf[width - 1] = 0x20;
  return buf;
}

function tarHeader({ name, typeflag, size, linkname = '', mode = 0o644 }) {
  const b = Buffer.alloc(BLOCK);
  Buffer.from(name).copy(b, 0, 0, 100);
  octalField(8, mode).copy(b, 100);
  octalField(8, 0).copy(b, 108);
  octalField(8, 0).copy(b, 116);
  octalField(12, size).copy(b, 124);
  octalField(12, 0).copy(b, 136);
  b.fill(0x20, 148, 156);
  b[156] = typeflag.charCodeAt(0);
  Buffer.from(linkname).copy(b, 157, 0, 100);
  b.write('ustar\0', 257);
  b[263] = 0x30;
  b[264] = 0x30;
  let sum = 0;
  for (const x of b) sum += x;
  const chk = sum.toString(8).padStart(6, '0');
  b.write(chk, 148);
  b[154] = 0;
  b[155] = 0x20;
  return b;
}

function pad512(n) {
  const rem = n % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

function gnuLongTar({ name, linkname, data, typeflag = '0' }) {
  const parts = [];
  if (name.length > 100) {
    const payload = Buffer.concat([Buffer.from(name), Buffer.from([0])]);
    parts.push(tarHeader({ name: '././@LongLink', typeflag: 'L', size: payload.length, mode: 0 }));
    parts.push(payload);
    parts.push(Buffer.alloc(pad512(payload.length)));
  }
  if (linkname && linkname.length > 100) {
    const payload = Buffer.concat([Buffer.from(linkname), Buffer.from([0])]);
    parts.push(tarHeader({ name: '././@LongLink', typeflag: 'K', size: payload.length, mode: 0 }));
    parts.push(payload);
    parts.push(Buffer.alloc(pad512(payload.length)));
  }
  const body = data ?? Buffer.alloc(0);
  parts.push(tarHeader({
    name: name.slice(0, 100),
    typeflag,
    size: typeflag === '2' || typeflag === '1' ? 0 : body.length,
    linkname: (linkname ?? '').slice(0, 100),
    mode: 0o644,
  }));
  if (typeflag !== '2' && typeflag !== '1') {
    parts.push(body);
    parts.push(Buffer.alloc(pad512(body.length)));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Uint8Array.from(Buffer.concat(parts));
}

function sparseTar() {
  const hdr = tarHeader({ name: 'hole', typeflag: 'S', size: 0, mode: 0o644 });
  return Uint8Array.from(Buffer.concat([hdr, Buffer.alloc(BLOCK * 2)]));
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function zipDataDescriptor({ name, payload }) {
  const flags = 0x8 | 0x800;
  const crc = crc32(payload);
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(flags),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(name.length),
    u16(0),
    Buffer.from(name),
    payload,
    u32(0x08074b50),
    u32(crc),
    u32(payload.length),
    u32(payload.length),
  ]);
  const cd = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(flags),
    u16(0),
    u16(0),
    u16(0),
    u32(crc),
    u32(payload.length),
    u32(payload.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    Buffer.from(name),
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
  return Uint8Array.from(Buffer.concat([local, cd, eocd]));
}

test('GNU L/K long name and linkname are applied, not returned as entries', () => {
  const longName = `${'n'.repeat(180)}.txt`;
  const data = Buffer.from('gnu-l');
  const tar = gnuLongTar({ name: longName, data });
  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, longName);
  equalBytes(got[0].data, data, 'gnu L data');

  const longLink = `tgt/${'t'.repeat(160)}`;
  const linkTar = gnuLongTar({ name: 'link', linkname: longLink, typeflag: '2', data: Buffer.alloc(0) });
  const links = tarExtract(linkTar);
  assert.equal(links.length, 1);
  assert.equal(links[0].type, 'symlink');
  assert.equal(links[0].linkname, longLink);
  assert.equal(links[0].name, 'link');

  const packet = {
    schema: 1,
    package: 'archive',
    cases: [
      {
        id: 'gnu-long-name',
        kind: 'tar',
        archiveHex: Buffer.from(tar).toString('hex'),
        entries: [{ name: longName, dataHex: data.toString('hex') }],
      },
      {
        id: 'gnu-long-link',
        kind: 'tar',
        archiveHex: Buffer.from(linkTar).toString('hex'),
        entries: [{ name: 'link', type: 'symlink', linkname: longLink, dataHex: '' }],
      },
    ],
  };
  const out = go(['-pkg', 'archive', '-verify'], JSON.stringify(packet));
  assert.match(out, /Go verified 2 archive cases/);
});

test('GNU L tar via 1-byte TarReader matches tarExtract', () => {
  const longName = `${'p'.repeat(140)}/f.txt`;
  const data = Buffer.from('chunked');
  const tar = gnuLongTar({ name: longName, data });
  const chunked = [];
  const reader = new TarReader();
  reader.on('entry', (e) => chunked.push(e));
  for (let i = 0; i < tar.length; i++) reader.write(tar.subarray(i, i + 1));
  reader.end();
  const whole = tarExtract(tar);
  assert.equal(chunked.length, whole.length);
  assert.equal(chunked[0].name, whole[0].name);
  equalBytes(chunked[0].data, whole[0].data, '1-byte stream data');
});

test('sparse tar typeflag S throws TarFormatError', () => {
  assert.throws(() => tarExtract(sparseTar()), TarFormatError);
  const reader = new TarReader();
  reader.on('entry', () => {
    throw new Error('sparse must not emit entries');
  });
  assert.throws(() => {
    const raw = sparseTar();
    reader.write(raw);
    reader.end();
  }, TarFormatError);
});

test('char and block device types round-trip and Go reads them', () => {
  const tar = tarCreate([
    { name: 'cdev', type: 'char', data: new Uint8Array() },
    { name: 'bdev', type: 'block', data: new Uint8Array() },
  ]);
  const got = tarExtract(tar);
  assert.equal(got[0].type, 'char');
  assert.equal(got[1].type, 'block');
  const packet = {
    schema: 1,
    package: 'archive',
    cases: [{
      id: 'tar-char-block',
      kind: 'tar',
      archiveHex: Buffer.from(tar).toString('hex'),
      entries: got.map((e) => ({
        name: e.name,
        type: e.type,
        dataHex: Buffer.from(e.data ?? []).toString('hex'),
      })),
    }],
  };
  const out = go(['-pkg', 'archive', '-verify'], JSON.stringify(packet));
  assert.match(out, /Go verified 1 archive cases/);
});

test('zip data descriptor (GPBF bit 3) extracts payload; Go reads it', () => {
  const payload = Buffer.from('hello-dd');
  const zip = zipDataDescriptor({ name: 'dd.txt', payload });
  const got = zipExtract(zip);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'dd.txt');
  equalBytes(got[0].data, payload, 'data-descriptor payload');
  const packet = {
    schema: 1,
    package: 'archive',
    cases: [{
      id: 'zip-data-descriptor',
      kind: 'zip',
      archiveHex: Buffer.from(zip).toString('hex'),
      entries: [{ name: 'dd.txt', dataHex: payload.toString('hex') }],
    }],
  };
  const out = go(['-pkg', 'archive', '-verify'], JSON.stringify(packet));
  assert.match(out, /Go verified 1 archive cases/);
});
