import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSpawnSync as spawnSync, goExecutable } from '../../../scripts/native-test-tools.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipCreate, zipExtract, ZipReader, ZipWriter } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');

const MODE_DIR = 0x80000000;
const MODE_SYMLINK = 0x08000000;

const GO_SRC = `package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"os"
)

type dumpEntry struct {
	Name           string \`json:"name"\`
	Method         uint16 \`json:"method"\`
	Mode           uint32 \`json:"mode"\`
	CreatorVersion uint16 \`json:"creatorVersion"\`
	ExternalAttrs  uint32 \`json:"externalAttrs"\`
	Comment        string \`json:"comment"\`
}

type writeEntry struct {
	Name    string \`json:"name"\`
	Method  uint16 \`json:"method"\`
	Comment string \`json:"comment"\`
	Data    string \`json:"data"\`
	Mode    uint32 \`json:"mode"\`
	SetMode bool   \`json:"setMode"\`
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
			Name:           f.Name,
			Method:         f.Method,
			Mode:           uint32(f.Mode()),
			CreatorVersion: f.CreatorVersion,
			ExternalAttrs:  f.ExternalAttrs,
			Comment:        f.Comment,
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
		if e.SetMode {
			hdr.SetMode(fs.FileMode(e.Mode))
		}
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp14-'));
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

function assertMode(got, dumped, label) {
  assert.equal(got.mode >>> 0, dumped.mode >>> 0, `${label} mode vs FileHeader.Mode`);
  assert.equal(got.method === 0 || got.method === 8, true, `${label} method stays 0|8`);
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment`);
}

test('Go fixture zip entries: extract mode matches FileHeader.Mode', () => {
  const packet = loadFixtures();
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(zipCases.length >= 10, zipCases.length);

  let sawFat666 = false;
  let sawDirMode = false;
  let sawUnixZero = false;
  for (const c of zipCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const got = zipExtract(raw);
    const dumped = goDump(raw) ?? [];
    assert.equal(got.length, dumped.length, `${c.id} entry count`);

    for (let i = 0; i < dumped.length; i++) {
      const label = `${c.id}[${i}]`;
      assert.equal(got[i].name, dumped[i].name, `${label} name`);
      assertMode(got[i], dumped[i], label);
      if ((dumped[i].mode >>> 0) === 0o666) sawFat666 = true;
      if ((dumped[i].mode >>> 0) & MODE_DIR) sawDirMode = true;
      if ((dumped[i].creatorVersion >>> 8) === 3 && dumped[i].externalAttrs === 0) {
        assert.equal(got[i].mode >>> 0, 0, `${label} unix empty attrs Mode()=0`);
        sawUnixZero = true;
      }
    }

    const streamed = streamExtract(raw);
    assert.equal(streamed.length, got.length, `${c.id} stream count`);
    for (let i = 0; i < got.length; i++) {
      assert.equal(streamed[i].mode >>> 0, got[i].mode >>> 0, `${c.id}[${i}] stream mode`);
      assert.equal(streamed[i].atime, undefined, `${c.id}[${i}] stream no atime`);
      assert.equal(streamed[i].ctime, undefined, `${c.id}[${i}] stream no ctime`);
    }
  }
  assert.ok(sawFat666, 'fixtures include FAT default 0666');
  assert.ok(sawDirMode, 'fixtures include directory ModeDir');
  assert.ok(sawUnixZero, 'fixtures include unix creator with empty attrs');
});

test('Go-written zip SetMode extracts field-level vs FileHeader.Mode', () => {
  const zip = goWrite([
    { name: 'a.txt', method: 0, data: 'hi', setMode: true, mode: 0o644 },
    { name: 'bin', method: 0, data: 'x', setMode: true, mode: 0o755 },
    { name: 'dir/', method: 0, data: '', setMode: true, mode: (0o755 | MODE_DIR) >>> 0 },
    { name: 'link', method: 0, data: '', setMode: true, mode: (MODE_SYMLINK | 0o777) >>> 0 },
    { name: 'plain', method: 8, data: 'p' },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 5);
  assert.equal(got[0].mode >>> 0, 0o644);
  assert.equal(got[1].mode >>> 0, 0o755);
  assert.equal(got[2].mode >>> 0, (0o755 | MODE_DIR) >>> 0);
  assert.equal(got[3].mode >>> 0, (MODE_SYMLINK | 0o777) >>> 0);
  assert.equal(got[4].mode >>> 0, 0o666);
  for (let i = 0; i < dumped.length; i++) {
    assertMode(got[i], dumped[i], `go-write[${i}]`);
  }
  assert.equal(got.comment, undefined);
});

test('zipCreate/ZipWriter mode round-trip vs Go FileHeader.Mode; method union stays 0|8', () => {
  const zip = zipCreate([
    { name: 's.txt', method: 0, data: new TextEncoder().encode('store-me'), mode: 0o644 },
    { name: 'd.txt', method: 8, data: new TextEncoder().encode('deflate payload'), mode: 0o755 },
    { name: 'folder/', method: 0, data: new Uint8Array(), mode: (0o755 | MODE_DIR) >>> 0 },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(Buffer.from(zip));
  assert.equal(got.length, 3);
  assert.equal(got[0].method, 0);
  assert.equal(got[1].method, 8);
  assert.equal(got[0].mode >>> 0, 0o644);
  assert.equal(got[1].mode >>> 0, 0o755);
  assert.equal(got[2].mode >>> 0, (0o755 | MODE_DIR) >>> 0);
  for (let i = 0; i < dumped.length; i++) {
    assertMode(got[i], dumped[i], `create[${i}]`);
  }

  const w = new ZipWriter();
  const payload = new TextEncoder().encode('writer-bytes');
  w.writeHeader({ name: 'w.txt', method: 8, data: payload, size: payload.length, mode: 0o640 });
  w.write(payload);
  const writerZip = w.end();
  const fromWriter = zipExtract(writerZip);
  const dumpedW = goDump(Buffer.from(writerZip));
  assert.equal(fromWriter[0].mode >>> 0, 0o640);
  assertMode(fromWriter[0], dumpedW[0], 'writer');
});

test('zip-zip64-crafted unix creator empty attrs Mode()=0; no atime/ctime Date; no archive comment API', () => {
  const packet = loadFixtures();
  const c = packet.cases.find((x) => x.id === 'zip-zip64-crafted');
  assert.ok(c);
  const raw = Buffer.from(c.archiveHex, 'hex');
  const got = zipExtract(raw);
  const dumped = goDump(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].mode >>> 0, 0);
  assertMode(got[0], dumped[0], 'zip64');
  assert.equal(Object.hasOwn(got, 'comment'), false);
});
