import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { zipExtract, ZipReader } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const GPBF_DATA_DESCRIPTOR = 0x8;

const GO_SRC = `package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
)

type dumpEntry struct {
	Name           string \`json:"name"\`
	Method         uint16 \`json:"method"\`
	CRC32          uint32 \`json:"crc32"\`
	Size           uint64 \`json:"size"\`
	CompressedSize uint64 \`json:"compressedSize"\`
	Comment        string \`json:"comment"\`
	Flags          uint16 \`json:"flags"\`
}

type dumpOut struct {
	ArchiveComment string      \`json:"archiveComment"\`
	Files          []dumpEntry \`json:"files"\`
}

type writeEntry struct {
	Name    string \`json:"name"\`
	Method  uint16 \`json:"method"\`
	Comment string \`json:"comment"\`
	Data    string \`json:"data"\`
}

func fail(err error) {
	if err == nil {
		return
	}
	os.Stderr.WriteString(err.Error() + "\\n")
	os.Exit(1)
}

func dump() {
	raw, err := io.ReadAll(os.Stdin)
	fail(err)
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	fail(err)
	out := dumpOut{ArchiveComment: zr.Comment, Files: []dumpEntry{}}
	for _, f := range zr.File {
		rc, err := f.Open()
		fail(err)
		_, err = io.Copy(io.Discard, rc)
		rc.Close()
		fail(err)
		out.Files = append(out.Files, dumpEntry{
			Name:           f.Name,
			Method:         f.Method,
			CRC32:          f.CRC32,
			Size:           f.UncompressedSize64,
			CompressedSize: f.CompressedSize64,
			Comment:        f.Comment,
			Flags:          f.Flags,
		})
	}
	fail(json.NewEncoder(os.Stdout).Encode(out))
}

func writeZip() {
	var entries []writeEntry
	fail(json.NewDecoder(os.Stdin).Decode(&entries))
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		hdr := &zip.FileHeader{Name: e.Name, Method: e.Method, Comment: e.Comment}
		fw, err := w.CreateHeader(hdr)
		fail(err)
		if len(e.Data) > 0 {
			_, err := fw.Write([]byte(e.Data))
			fail(err)
		}
	}
	fail(w.Close())
	_, err := os.Stdout.Write(buf.Bytes())
	fail(err)
}

func main() {
	if len(os.Args) < 2 {
		os.Stderr.WriteString("usage: goinspect dump|write\\n")
		os.Exit(1)
	}
	switch os.Args[1] {
	case "dump":
		dump()
	case "write":
		writeZip()
	default:
		os.Stderr.WriteString("usage: goinspect dump|write\\n")
		os.Exit(1)
	}
}
`;

let inspectDir;

function goCmd() {
  if (process.env.RUSTD_GO === 'path') return { command: 'go', prefix: [] };
  return { command: 'mise', prefix: ['exec', '--', 'go'] };
}

function compileInspect() {
  if (inspectDir) return inspectDir;
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp17-'));
  writeFileSync(join(dir, 'main.go'), GO_SRC);
  const { command, prefix } = goCmd();
  const result = spawnSync(command, [...prefix, 'build', '-o', 'goinspect', 'main.go'], {
    cwd: dir, encoding: 'utf8', timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`go build goinspect exited ${result.status}: ${result.stderr}`);
  }
  inspectDir = dir;
  return dir;
}

function goDump(zipBytes) {
  const dir = compileInspect();
  const result = spawnSync(join(dir, 'goinspect'), ['dump'], {
    input: zipBytes,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`godump exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function goWrite(entries) {
  const dir = compileInspect();
  const result = spawnSync(join(dir, 'goinspect'), ['write'], {
    input: JSON.stringify(entries),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`gowrite exited ${result.status}: ${result.stderr}`);
  }
  return Buffer.from(result.stdout);
}

function loadFixtures() {
  const { command, prefix } = goCmd();
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', '-pkg', 'archive'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Go fixtures exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function streamExtract(zipBytes) {
  const chunked = [];
  const reader = new ZipReader();
  reader.on('entry', (e) => chunked.push(e));
  const zip = zipBytes instanceof Uint8Array ? zipBytes : Uint8Array.from(zipBytes);
  for (let i = 0; i < zip.length; i += 17) reader.write(zip.subarray(i, i + 17));
  reader.end();
  return chunked;
}

function ieeeCrc(data) {
  return zlibCrc32(data) >>> 0;
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
function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function jsComment(entry) {
  return entry.comment ?? '';
}

function assertNoInvented(got, label) {
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment`);
  assert.equal(got.extra, undefined, `${label} no extra field`);
}

function assertFields(got, dumped, label) {
  assert.equal(got.name, dumped.name, `${label} name`);
  assert.equal(jsComment(got), dumped.comment ?? '', `${label} comment vs FileHeader.Comment`);
  assert.equal(got.crc32 >>> 0, dumped.crc32 >>> 0, `${label} crc32 vs FileHeader.CRC32`);
  assert.equal(got.size, Number(dumped.size), `${label} size vs FileHeader.UncompressedSize64`);
  assert.equal(got.compressedSize, Number(dumped.compressedSize), `${label} compressedSize vs FileHeader.CompressedSize64`);
  assert.equal(got.method === 0 || got.method === 8, true, `${label} method stays 0|8`);
  assertNoInvented(got, label);
}

function localHeaders(zip) {
  const buf = Buffer.from(zip);
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x04034b50) {
      const flags = buf.readUInt16LE(i + 6);
      const method = buf.readUInt16LE(i + 8);
      const crc = buf.readUInt32LE(i + 14);
      const compressed = buf.readUInt32LE(i + 18);
      const size = buf.readUInt32LE(i + 22);
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
      out.push({ flags, method, crc, compressed, size, name, offset: i });
      i += 30 + nameLen + extraLen;
      continue;
    }
    if (sig === 0x02014b50 || sig === 0x06054b50 || sig === 0x06064b50) break;
    i += 1;
  }
  return out;
}

function zipDataDescriptor({
  name,
  payload,
  method = 0,
  comment = '',
  withSig = true,
  zip64 = false,
}) {
  const flags = GPBF_DATA_DESCRIPTOR | 0x800;
  const crc = ieeeCrc(payload);
  const compressed = method === 8 ? deflateRawSync(payload) : Buffer.from(payload);
  const extra = zip64
    ? Buffer.concat([
      u16(0x0001),
      u16(16),
      u64(payload.length),
      u64(compressed.length),
    ])
    : Buffer.alloc(0);
  const localSizes = zip64 ? 0xffffffff : 0;
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(zip64 ? 45 : 20),
    u16(flags),
    u16(method),
    u16(0),
    u16(0),
    u32(0),
    u32(localSizes),
    u32(localSizes),
    u16(name.length),
    u16(extra.length),
    Buffer.from(name),
    extra,
    compressed,
    ...(withSig ? [u32(0x08074b50)] : []),
    u32(crc),
    ...(zip64
      ? [u64(compressed.length), u64(payload.length)]
      : [u32(compressed.length), u32(payload.length)]),
  ]);
  const commentBuf = Buffer.from(comment);
  const cdExtra = zip64
    ? Buffer.concat([
      u16(0x0001),
      u16(24),
      u64(payload.length),
      u64(compressed.length),
      u64(0),
    ])
    : Buffer.alloc(0);
  const cd = Buffer.concat([
    u32(0x02014b50),
    u16(zip64 ? 45 : 20),
    u16(zip64 ? 45 : 20),
    u16(flags),
    u16(method),
    u16(0),
    u16(0),
    u32(crc),
    u32(zip64 ? 0xffffffff : compressed.length),
    u32(zip64 ? 0xffffffff : payload.length),
    u16(name.length),
    u16(cdExtra.length),
    u16(commentBuf.length),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    Buffer.from(name),
    cdExtra,
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

test('Go fixture zip files with GPBF bit 3: comment/crc32/size/compressedSize vs FileHeader', () => {
  const packet = loadFixtures();
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(zipCases.length >= 10, zipCases.length);

  let sawDd = false;
  let sawStore = false;
  let sawDeflate = false;
  let sawEntryComment = false;
  let sawArchiveComment = false;
  for (const c of zipCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const dumped = goDump(raw);
    const files = dumped.files ?? [];
    if (files.length === 0) continue;
    const locals = localHeaders(raw);
    const ddFiles = files.filter((f) => (f.flags & GPBF_DATA_DESCRIPTOR) !== 0);
    if (ddFiles.length === 0) continue;
    sawDd = true;

    const got = zipExtract(raw);
    assert.equal(got.length, files.length, `${c.id} entry count`);
    assert.equal(Object.hasOwn(got, 'comment'), false, `${c.id} no archive-level comment on extract`);
    assert.equal(got.archiveComment, undefined, `${c.id} no archiveComment`);
    assert.equal(got.extra, undefined, `${c.id} no extra on extract`);
    if ((dumped.archiveComment ?? '') !== '') {
      sawArchiveComment = true;
      assert.equal(got.comment, undefined, `${c.id} Go Reader.Comment is not a JS field`);
    }

    for (let i = 0; i < files.length; i++) {
      const label = `${c.id}[${i}]`;
      if ((files[i].flags & GPBF_DATA_DESCRIPTOR) === 0) continue;
      assert.equal((locals[i]?.flags ?? 0) & GPBF_DATA_DESCRIPTOR, GPBF_DATA_DESCRIPTOR, `${label} local GPBF bit 3`);
      assert.equal(locals[i].crc, 0, `${label} local CRC32 is 0 when bit 3 set`);
      assert.equal(locals[i].compressed === 0 || locals[i].compressed === 0xffffffff, true, `${label} local compressed size deferred`);
      assert.equal(locals[i].size === 0 || locals[i].size === 0xffffffff, true, `${label} local size deferred`);
      assertFields(got[i], files[i], label);
      assert.equal(got[i].crc32 >>> 0, ieeeCrc(got[i].data), `${label} crc32 vs IEEE of data`);
      assert.equal(got[i].size, got[i].data.length, `${label} size vs data`);
      if (got[i].method === 0) {
        sawStore = true;
        assert.equal(got[i].compressedSize, got[i].size, `${label} store compressedSize==size`);
      }
      if (got[i].method === 8) sawDeflate = true;
      if (jsComment(got[i]) !== '') sawEntryComment = true;
    }

    const streamed = streamExtract(raw);
    assert.equal(streamed.length, got.length, `${c.id} stream count`);
    for (let i = 0; i < got.length; i++) {
      if ((files[i].flags & GPBF_DATA_DESCRIPTOR) === 0) continue;
      assert.equal(jsComment(streamed[i]), jsComment(got[i]), `${c.id}[${i}] stream comment`);
      assert.equal(streamed[i].crc32 >>> 0, got[i].crc32 >>> 0, `${c.id}[${i}] stream crc32`);
      assert.equal(streamed[i].size, got[i].size, `${c.id}[${i}] stream size`);
      assert.equal(streamed[i].compressedSize, got[i].compressedSize, `${c.id}[${i}] stream compressedSize`);
      assertNoInvented(streamed[i], `${c.id}[${i}] stream`);
    }
  }
  assert.ok(sawDd, 'Go fixtures include GPBF bit 3 data-descriptor files');
  assert.ok(sawStore, 'data-descriptor fixtures include store');
  assert.ok(sawDeflate, 'data-descriptor fixtures include deflate');
  assert.ok(sawEntryComment, 'data-descriptor fixtures include FileHeader.Comment');
  assert.ok(sawArchiveComment, 'fixtures include archive Reader.Comment (not a JS API)');
});

test('Go-written zip CreateHeader sets GPBF bit 3; extract matches FileHeader', () => {
  const zip = goWrite([
    { name: 's.txt', method: 0, data: 'store-payload' },
    { name: 'd.txt', method: 8, comment: 'entry-note', data: 'deflate payload now' },
    { name: 'empty', method: 0, data: '' },
    { name: 'u.txt', method: 0, comment: 'café', data: 'u' },
  ]);
  const locals = localHeaders(zip);
  assert.equal(locals.length, 4);
  for (const loc of locals) {
    assert.equal(loc.flags & GPBF_DATA_DESCRIPTOR, GPBF_DATA_DESCRIPTOR, `${loc.name} Go CreateHeader sets bit 3`);
    assert.equal(loc.crc, 0, `${loc.name} local CRC32 zero`);
    assert.equal(loc.compressed, 0, `${loc.name} local compressed zero`);
    assert.equal(loc.size, 0, `${loc.name} local size zero`);
  }
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 4);
  assert.equal(got[0].method, 0);
  assert.equal(got[0].compressedSize, got[0].size);
  assert.equal(got[1].method, 8);
  assert.equal(got[1].comment, 'entry-note');
  assert.equal(got[2].size, 0);
  assert.equal(got[2].crc32 >>> 0, 0);
  assert.equal(got[2].compressedSize, 0);
  assert.equal(got[3].comment, 'café');
  for (let i = 0; i < dumped.files.length; i++) {
    assert.equal(dumped.files[i].flags & GPBF_DATA_DESCRIPTOR, GPBF_DATA_DESCRIPTOR);
    assertFields(got[i], dumped.files[i], `go-write[${i}]`);
    assert.equal(got[i].crc32 >>> 0, ieeeCrc(got[i].data), `go-write[${i}] ieee`);
  }
  assert.equal(dumped.archiveComment, '');
  assert.equal(got.comment, undefined);
  assert.equal(got.archiveComment, undefined);
});

test('crafted GPBF bit 3 store (with and without DD signature) vs FileHeader', () => {
  const payload = Buffer.from('hello-dd');
  for (const withSig of [true, false]) {
    const zip = zipDataDescriptor({
      name: 'dd.txt',
      payload,
      method: 0,
      comment: 'from-dd',
      withSig,
    });
    const locals = localHeaders(zip);
    assert.equal(locals[0].flags & GPBF_DATA_DESCRIPTOR, GPBF_DATA_DESCRIPTOR, `sig=${withSig} bit 3`);
    assert.equal(locals[0].crc, 0);
    const got = zipExtract(zip);
    const dumped = goDump(zip);
    assert.equal(got.length, 1);
    assert.equal(got[0].name, 'dd.txt');
    assert.equal(got[0].method, 0);
    assert.equal(got[0].comment, 'from-dd');
    assert.equal(got[0].size, payload.length);
    assert.equal(got[0].compressedSize, payload.length);
    assert.equal(got[0].crc32 >>> 0, ieeeCrc(payload));
    assertFields(got[0], dumped.files[0], `crafted-sig=${withSig}`);
    const streamed = streamExtract(zip);
    assert.equal(streamed[0].comment, 'from-dd');
    assert.equal(streamed[0].crc32 >>> 0, got[0].crc32 >>> 0);
    assert.equal(streamed[0].compressedSize, got[0].size);
    assertNoInvented(streamed[0], `stream-sig=${withSig}`);
  }
});

test('crafted zip64 data-descriptor (GPBF bit 3) sizes/crc32/comment vs FileHeader', () => {
  const payload = Buffer.from('zip64-dd');
  const zip = zipDataDescriptor({
    name: 'z64.txt',
    payload,
    method: 0,
    comment: '',
    withSig: true,
    zip64: true,
  });
  const locals = localHeaders(zip);
  assert.equal(locals[0].flags & GPBF_DATA_DESCRIPTOR, GPBF_DATA_DESCRIPTOR);
  assert.equal(locals[0].compressed, 0xffffffff);
  assert.equal(locals[0].size, 0xffffffff);
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'z64.txt');
  assert.equal(got[0].size, payload.length);
  assert.equal(got[0].compressedSize, payload.length);
  assert.equal(got[0].crc32 >>> 0, ieeeCrc(payload));
  assert.equal(got[0].comment, undefined);
  assertFields(got[0], dumped.files[0], 'zip64-dd');
  assert.equal(Object.hasOwn(got, 'comment'), false);
  assertNoInvented(got[0], 'zip64-dd');
});

test('crafted GPBF bit 3 deflate compressedSize vs Go dump of same bytes', () => {
  const payload = Buffer.from('deflate payload that should shrink a little');
  const zip = zipDataDescriptor({
    name: 'd.txt',
    payload,
    method: 8,
    comment: 'deflate-dd',
    withSig: true,
  });
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 8);
  assert.equal(got[0].size, payload.length);
  assert.equal(got[0].crc32 >>> 0, ieeeCrc(payload));
  assert.equal(got[0].comment, 'deflate-dd');
  assert.notEqual(got[0].compressedSize, got[0].size, 'deflate compressedSize is not uncompressed size');
  assertFields(got[0], dumped.files[0], 'deflate-dd');
  assert.equal(dumped.files[0].flags & GPBF_DATA_DESCRIPTOR, GPBF_DATA_DESCRIPTOR);
});
