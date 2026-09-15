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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp16-'));
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

function jsComment(entry) {
  return entry.comment ?? '';
}

function assertComment(got, dumped, label) {
  assert.equal(jsComment(got), dumped.comment ?? '', `${label} comment vs FileHeader.Comment`);
  assert.equal(got.method === 0 || got.method === 8, true, `${label} method stays 0|8`);
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment on entry`);
  assert.equal(got.extra, undefined, `${label} no extra field`);
}

test('Go fixture zip entries: extract comment matches FileHeader.Comment', () => {
  const packet = loadFixtures();
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(zipCases.length >= 10, zipCases.length);

  let sawEmpty = false;
  let sawEntryComment = false;
  let sawArchiveComment = false;
  for (const c of zipCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const got = zipExtract(raw);
    const dumped = goDump(raw);
    const files = dumped.files ?? [];
    assert.equal(got.length, files.length, `${c.id} entry count`);
    assert.equal(Object.hasOwn(got, 'comment'), false, `${c.id} no archive-level comment on extract`);
    assert.equal(got.archiveComment, undefined, `${c.id} no archiveComment on extract`);
    assert.equal(got.extra, undefined, `${c.id} no extra on extract`);

    if ((dumped.archiveComment ?? '') !== '') {
      sawArchiveComment = true;
      assert.equal(got.comment, undefined, `${c.id} Go Reader.Comment is not a JS field`);
    }

    for (let i = 0; i < files.length; i++) {
      const label = `${c.id}[${i}]`;
      assert.equal(got[i].name, files[i].name, `${label} name`);
      assertComment(got[i], files[i], label);
      if (c.entries?.[i]?.comment != null) {
        assert.equal(jsComment(got[i]), c.entries[i].comment, `${label} vs fixture`);
      }
      if (jsComment(got[i]) === '') sawEmpty = true;
      if (jsComment(got[i]) !== '') sawEntryComment = true;
    }

    const streamed = streamExtract(raw);
    assert.equal(streamed.length, got.length, `${c.id} stream count`);
    for (let i = 0; i < got.length; i++) {
      assert.equal(jsComment(streamed[i]), jsComment(got[i]), `${c.id}[${i}] stream comment`);
      assert.equal(streamed[i].atime, undefined, `${c.id}[${i}] stream no atime`);
      assert.equal(streamed[i].ctime, undefined, `${c.id}[${i}] stream no ctime`);
      assert.equal(streamed[i].extra, undefined, `${c.id}[${i}] stream no extra`);
      assert.equal(streamed[i].archiveComment, undefined, `${c.id}[${i}] stream no archiveComment`);
    }
  }
  assert.ok(sawEmpty, 'fixtures include empty FileHeader.Comment');
  assert.ok(sawEntryComment, 'fixtures include zip-comment entry Comment');
  assert.ok(sawArchiveComment, 'fixtures include zip-comment archive Reader.Comment');
});

test('Go-written zip comments extract field-level vs FileHeader.Comment', () => {
  const long = 'c'.repeat(200);
  const zip = goWrite([
    { name: 'empty.txt', method: 0, data: 'hi' },
    { name: 'ascii.txt', method: 8, comment: 'entry', data: 'c' },
    { name: 'utf8.txt', method: 0, comment: 'café', data: 'u' },
    { name: 'long.txt', method: 8, comment: long, data: 'L' },
    { name: 'space.txt', method: 0, comment: ' ', data: 's' },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 5);
  assert.equal(got[0].comment, undefined, 'empty FileHeader.Comment is omitted');
  assert.equal(got[1].comment, 'entry');
  assert.equal(got[2].comment, 'café');
  assert.equal(got[3].comment, long);
  assert.equal(got[4].comment, ' ');
  assert.equal(dumped.archiveComment, '', 'Go write has no archive comment');
  for (let i = 0; i < dumped.files.length; i++) {
    assertComment(got[i], dumped.files[i], `go-write[${i}]`);
  }
  assert.equal(got.comment, undefined);
  assert.equal(got.archiveComment, undefined);
});

test('zipCreate/ZipWriter comment round-trip vs Go FileHeader.Comment; no extra/archive comment', () => {
  const zip = zipCreate([
    { name: 's.txt', method: 0, data: new TextEncoder().encode('store-me') },
    { name: 'd.txt', method: 8, comment: 'entry-note', data: new TextEncoder().encode('deflate payload') },
    { name: 'u.txt', method: 0, comment: '你好', data: new TextEncoder().encode('utf8') },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(Buffer.from(zip));
  assert.equal(got.length, 3);
  assert.equal(got[0].comment, undefined);
  assert.equal(got[1].comment, 'entry-note');
  assert.equal(got[2].comment, '你好');
  for (let i = 0; i < dumped.files.length; i++) {
    assertComment(got[i], dumped.files[i], `create[${i}]`);
  }
  assert.equal(dumped.archiveComment, '');

  const w = new ZipWriter();
  const payload = new TextEncoder().encode('writer-bytes');
  w.writeHeader({ name: 'w.txt', method: 8, data: payload, size: payload.length, comment: 'from-writer' });
  w.write(payload);
  const writerZip = w.end();
  const fromWriter = zipExtract(writerZip);
  const dumpedW = goDump(Buffer.from(writerZip));
  assert.equal(fromWriter[0].comment, 'from-writer');
  assertComment(fromWriter[0], dumpedW.files[0], 'writer');
  assert.equal(dumpedW.archiveComment, '');
});

test('zip-comment fixture: entry Comment vs FileHeader; Go Reader.Comment is not a JS API', () => {
  const packet = loadFixtures();
  const c = packet.cases.find((x) => x.id === 'zip-comment');
  assert.ok(c);
  const raw = Buffer.from(c.archiveHex, 'hex');
  const got = zipExtract(raw);
  const dumped = goDump(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].comment, 'entry');
  assertComment(got[0], dumped.files[0], 'zip-comment');
  assert.equal(dumped.archiveComment, 'archive-comment');
  assert.equal(Object.hasOwn(got, 'comment'), false);
  assert.equal(got.archiveComment, undefined);
  assert.equal(got[0].extra, undefined);
  assert.equal(got[0].atime, undefined);
  assert.equal(got[0].ctime, undefined);
});

test('zip-zip64-crafted empty comment matches Go; no atime/ctime/extra/archive comment', () => {
  const packet = loadFixtures();
  const c = packet.cases.find((x) => x.id === 'zip-zip64-crafted');
  assert.ok(c);
  const raw = Buffer.from(c.archiveHex, 'hex');
  const got = zipExtract(raw);
  const dumped = goDump(raw);
  assert.equal(got.length, 1);
  assert.equal(got[0].comment, undefined);
  assertComment(got[0], dumped.files[0], 'zip64');
  assert.equal(Object.hasOwn(got, 'comment'), false);
});
