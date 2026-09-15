import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSpawnSync as spawnSync, goExecutable } from '../../../scripts/native-test-tools.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
	Name    string \`json:"name"\`
	Method  uint16 \`json:"method"\`
	Comment string \`json:"comment"\`
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
	out := []dumpEntry{}
	for _, f := range zr.File {
		rc, err := f.Open()
		fail(err)
		_, err = io.Copy(io.Discard, rc)
		rc.Close()
		fail(err)
		out = append(out, dumpEntry{
			Name:    f.Name,
			Method:  f.Method,
			Comment: f.Comment,
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp13-'));
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

function assertMethod(got, dumped, label) {
  assert.equal(got.method, dumped.method, `${label} method vs FileHeader.Method`);
  assert.ok(got.method === 0 || got.method === 8, `${label} method is 0|8, got ${got.method}`);
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment`);
}

test('Go fixture zip entries: extract method matches FileHeader.Method (0 store / 8 deflate)', () => {
  const packet = loadFixtures();
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(zipCases.length >= 10, zipCases.length);

  let sawStore = false;
  let sawDeflate = false;
  let sawEmpty = false;
  for (const c of zipCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const got = zipExtract(raw);
    const dumped = goDump(raw) ?? [];
    assert.equal(got.length, dumped.length, `${c.id} entry count`);

    for (let i = 0; i < dumped.length; i++) {
      const label = `${c.id}[${i}]`;
      assert.equal(got[i].name, dumped[i].name, `${label} name`);
      assertMethod(got[i], dumped[i], label);
      if (got[i].method === 0) sawStore = true;
      if (got[i].method === 8) sawDeflate = true;
      if (got[i].size === 0) sawEmpty = true;

      const want = c.entries?.[i];
      if (want?.method != null) {
        assert.equal(got[i].method, want.method, `${label} method vs fixture`);
      }
    }

    const streamed = streamExtract(raw);
    assert.equal(streamed.length, got.length, `${c.id} stream count`);
    for (let i = 0; i < got.length; i++) {
      assert.equal(streamed[i].method, got[i].method, `${c.id}[${i}] stream method`);
      assert.equal(streamed[i].atime, undefined, `${c.id}[${i}] stream no atime`);
      assert.equal(streamed[i].ctime, undefined, `${c.id}[${i}] stream no ctime`);
    }
  }
  assert.ok(sawStore, 'fixtures include store method 0');
  assert.ok(sawDeflate, 'fixtures include deflate method 8');
  assert.ok(sawEmpty, 'fixtures include empty/zero-size entry');
});

test('Go-written zip method extracts field-level vs FileHeader.Method', () => {
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
  assert.equal(got[2].method, 0);
  assert.equal(got[3].method, 8);
  for (let i = 0; i < dumped.length; i++) {
    assertMethod(got[i], dumped[i], `go-write[${i}]`);
  }
  assert.equal(got.comment, undefined);
});

test('zipCreate/ZipWriter method round-trip vs Go FileHeader.Method; TS union stays 0|8', () => {
  const storeData = new TextEncoder().encode('store-me');
  const deflateData = new TextEncoder().encode('deflate payload that should shrink a little');
  const zip = zipCreate([
    { name: 's.txt', method: 0, data: storeData },
    { name: 'd.txt', method: 8, data: deflateData },
    { name: 'z', method: 0, data: new Uint8Array() },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(Buffer.from(zip));
  assert.equal(got.length, 3);
  assert.equal(got[0].method, 0);
  assert.equal(got[1].method, 8);
  assert.equal(got[2].method, 0);
  for (let i = 0; i < dumped.length; i++) {
    assertMethod(got[i], dumped[i], `create[${i}]`);
  }

  const w = new ZipWriter();
  const payload = new TextEncoder().encode('writer-bytes');
  w.writeHeader({ name: 'w.txt', method: 8, data: payload, size: payload.length });
  w.write(payload);
  const writerZip = w.end();
  const fromWriter = zipExtract(writerZip);
  const dumpedW = goDump(Buffer.from(writerZip));
  assert.equal(fromWriter[0].method, 8);
  assertMethod(fromWriter[0], dumpedW[0], 'writer');
});

test('zip-zip64-crafted method matches Go; no atime/ctime Date; no archive comment API', () => {
  const packet = loadFixtures();
  const c = packet.cases.find((x) => x.id === 'zip-zip64-crafted');
  assert.ok(c);
  const raw = Buffer.from(c.archiveHex, 'hex');
  const got = zipExtract(raw);
  const dumped = goDump(raw);
  assert.equal(got.length, 1);
  assertMethod(got[0], dumped[0], 'zip64');
  assert.ok(got[0].method === 0 || got[0].method === 8);
  assert.equal(Object.hasOwn(got, 'comment'), false);
});
