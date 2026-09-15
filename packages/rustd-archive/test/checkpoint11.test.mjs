import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSpawnSync as spawnSync, goExecutable } from '../../../scripts/native-test-tools.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { zipCreate, zipExtract, ZipReader, ZipWriter } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');

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
	DataHex        string \`json:"dataHex"\`
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

func fmtHex(b []byte) string {
	const hexdigits = "0123456789abcdef"
	dst := make([]byte, len(b)*2)
	for i, v := range b {
		dst[i*2] = hexdigits[v>>4]
		dst[i*2+1] = hexdigits[v&0x0f]
	}
	return string(dst)
}

func dump() {
	raw, err := io.ReadAll(os.Stdin)
	fail(err)
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	fail(err)
	out := []dumpEntry{}
	for _, f := range zr.File {
		rc, err := f.Open()
		fail(err)
		data, err := io.ReadAll(rc)
		rc.Close()
		fail(err)
		out = append(out, dumpEntry{
			Name:           f.Name,
			Method:         f.Method,
			CRC32:          f.CRC32,
			Size:           f.UncompressedSize64,
			CompressedSize: f.CompressedSize64,
			Comment:        f.Comment,
			DataHex:        fmtHex(data),
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
		data := []byte(e.Data)
		hdr := &zip.FileHeader{Name: e.Name, Method: e.Method, Comment: e.Comment}
		fw, err := w.CreateHeader(hdr)
		fail(err)
		if len(data) > 0 {
			_, err := fw.Write(data)
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp11-'));
  writeFileSync(join(dir, 'main.go'), GO_SRC);
  const { command, prefix } = goCmd();
  const result = spawnSync(command, [...prefix, 'build', '-o', goExecutable('goinspect'), 'main.go'], {
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
  const result = spawnSync(join(dir, goExecutable('goinspect')), ['dump'], {
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
  const result = spawnSync(join(dir, goExecutable('goinspect')), ['write'], {
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
  for (let i = 0; i < zip.length; i += 23) reader.write(zip.subarray(i, i + 23));
  reader.end();
  return chunked;
}

function ieeeCrc(data) {
  return zlibCrc32(data) >>> 0;
}

function assertSizes(got, dumped, label) {
  assert.equal(got.crc32 >>> 0, dumped.crc32 >>> 0, `${label} crc32`);
  assert.equal(got.size, Number(dumped.size), `${label} size`);
  assert.equal(got.compressedSize, Number(dumped.compressedSize), `${label} compressedSize`);
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment`);
}

test('Go fixture zip entries: extract crc32/size/compressedSize match Go FileHeader', () => {
  const packet = loadFixtures();
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(zipCases.length >= 10, zipCases.length);

  let sawStore = false;
  let sawDeflate = false;
  let sawEmpty = false;
  let sawZip64 = false;
  for (const c of zipCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const got = zipExtract(raw);
    const dumped = goDump(raw) ?? [];
    assert.equal(got.length, dumped.length, `${c.id} entry count`);

    for (let i = 0; i < dumped.length; i++) {
      const label = `${c.id}[${i}]`;
      assert.equal(got[i].name, dumped[i].name, `${label} name`);
      assertSizes(got[i], dumped[i], label);
      assert.equal(got[i].size, got[i].data.length, `${label} size vs data`);
      assert.equal(got[i].crc32 >>> 0, ieeeCrc(got[i].data), `${label} crc32 vs IEEE of data`);
      if (got[i].method === 0) {
        sawStore = true;
        assert.equal(got[i].compressedSize, got[i].size, `${label} store compressedSize==size`);
      }
      if (got[i].method === 8) sawDeflate = true;
      if (got[i].size === 0) sawEmpty = true;

      const want = c.entries?.[i];
      if (want?.crc32 != null) assert.equal(got[i].crc32 >>> 0, want.crc32 >>> 0, `${label} crc32 vs fixture`);
      if (want?.size != null) assert.equal(got[i].size, want.size, `${label} size vs fixture`);
      if (want?.compressedSize != null) {
        assert.equal(got[i].compressedSize, want.compressedSize, `${label} compressedSize vs fixture`);
      }
    }

    const streamed = streamExtract(raw);
    assert.equal(streamed.length, got.length, `${c.id} stream count`);
    for (let i = 0; i < got.length; i++) {
      assert.equal(streamed[i].crc32 >>> 0, got[i].crc32 >>> 0, `${c.id}[${i}] stream crc32`);
      assert.equal(streamed[i].size, got[i].size, `${c.id}[${i}] stream size`);
      assert.equal(streamed[i].compressedSize, got[i].compressedSize, `${c.id}[${i}] stream compressedSize`);
      assert.equal(streamed[i].atime, undefined, `${c.id}[${i}] stream no atime`);
      assert.equal(streamed[i].ctime, undefined, `${c.id}[${i}] stream no ctime`);
    }
    if (c.id === 'zip-zip64-crafted') sawZip64 = true;
  }
  assert.ok(sawStore, 'fixtures include store');
  assert.ok(sawDeflate, 'fixtures include deflate');
  assert.ok(sawEmpty, 'fixtures include empty/zero-size entry');
  assert.ok(sawZip64, 'fixtures include zip-zip64-crafted');
});

test('Go-written zip crc32/size/compressedSize extract field-level vs FileHeader', () => {
  const zip = goWrite([
    { name: 's.txt', method: 0, data: 'store-payload' },
    { name: 'd.txt', method: 8, data: 'deflate payload now' },
    { name: 'empty', method: 0, data: '' },
    { name: 'c.txt', method: 8, comment: 'entry', data: 'c' },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 4);
  assert.equal(got[0].method, 0);
  assert.equal(got[1].method, 8);
  assert.equal(got[2].size, 0);
  assert.equal(got[2].crc32 >>> 0, 0);
  assert.equal(got[2].compressedSize, 0);
  assert.equal(got[3].comment, 'entry');
  for (let i = 0; i < dumped.length; i++) {
    assertSizes(got[i], dumped[i], `go-write[${i}]`);
    assert.equal(got[i].crc32 >>> 0, ieeeCrc(got[i].data), `go-write[${i}] ieee`);
  }
  assert.equal(got.comment, undefined);
});

test('zipCreate crc32/size match Go FileHeader; store compressedSize==size; deflate compressedSize vs Go dump of same bytes', () => {
  const storeData = new TextEncoder().encode('store-me');
  const deflateData = new TextEncoder().encode('deflate payload that should shrink a little');
  const empty = new Uint8Array();
  const zip = zipCreate([
    { name: 's.txt', method: 0, data: storeData },
    { name: 'd.txt', method: 8, data: deflateData },
    { name: 'z', method: 0, data: empty },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(Buffer.from(zip));
  assert.equal(got.length, 3);
  assert.equal(got[0].method, 0);
  assert.equal(got[0].size, storeData.length);
  assert.equal(got[0].compressedSize, storeData.length);
  assert.equal(got[0].crc32 >>> 0, ieeeCrc(storeData));
  assert.equal(got[1].method, 8);
  assert.equal(got[1].size, deflateData.length);
  assert.equal(got[1].crc32 >>> 0, ieeeCrc(deflateData));
  assert.equal(got[2].size, 0);
  assert.equal(got[2].compressedSize, 0);
  assert.equal(got[2].crc32 >>> 0, 0);
  for (let i = 0; i < dumped.length; i++) {
    assertSizes(got[i], dumped[i], `create[${i}]`);
  }

  const w = new ZipWriter();
  const payload = new TextEncoder().encode('writer-bytes');
  w.writeHeader({ name: 'w.txt', method: 8, data: payload, size: payload.length });
  w.write(payload);
  const writerZip = w.end();
  const fromWriter = zipExtract(writerZip);
  const dumpedW = goDump(Buffer.from(writerZip));
  assert.equal(fromWriter[0].size, payload.length);
  assert.equal(fromWriter[0].crc32 >>> 0, ieeeCrc(payload));
  assertSizes(fromWriter[0], dumpedW[0], 'writer');
});

test('zip-zip64-crafted extra sizes and crc32 match Go; no archive comment API', () => {
  const packet = loadFixtures();
  const c = packet.cases.find((x) => x.id === 'zip-zip64-crafted');
  assert.ok(c);
  const raw = Buffer.from(c.archiveHex, 'hex');
  const got = zipExtract(raw);
  const dumped = goDump(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'z64.txt');
  assert.equal(got[0].size, 5);
  assert.equal(got[0].compressedSize, 5);
  assert.equal(got[0].crc32 >>> 0, ieeeCrc(Buffer.from('zip64')));
  assertSizes(got[0], dumped[0], 'zip64');
  if (c.entries?.[0]?.crc32 != null) {
    assert.equal(got[0].crc32 >>> 0, c.entries[0].crc32 >>> 0);
  }
  if (c.entries?.[0]?.compressedSize != null) {
    assert.equal(got[0].compressedSize, c.entries[0].compressedSize);
  }
  assert.equal(Object.hasOwn(got, 'comment'), false);
});
