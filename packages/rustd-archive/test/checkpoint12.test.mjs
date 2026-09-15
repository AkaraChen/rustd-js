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
	"time"
)

type dumpEntry struct {
	Name               string \`json:"name"\`
	Method             uint16 \`json:"method"\`
	ModifiedUnixMilli  int64  \`json:"modifiedUnixMilli"\`
	ModifiedUnix       int64  \`json:"modifiedUnix"\`
	ModifiedIsZero     bool   \`json:"modifiedIsZero"\`
	Comment            string \`json:"comment"\`
}

type writeEntry struct {
	Name        string \`json:"name"\`
	Method      uint16 \`json:"method"\`
	Comment     string \`json:"comment"\`
	Data        string \`json:"data"\`
	ModifiedUnix int64 \`json:"modifiedUnix"\`
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
			Name:              f.Name,
			Method:            f.Method,
			ModifiedUnixMilli: f.Modified.UnixMilli(),
			ModifiedUnix:      f.Modified.Unix(),
			ModifiedIsZero:    f.Modified.IsZero(),
			Comment:           f.Comment,
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
		if e.ModifiedUnix != 0 {
			hdr.Modified = time.Unix(e.ModifiedUnix, 0).UTC()
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp12-'));
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

function modifiedMs(entry) {
  assert.ok(entry.modified instanceof Date, 'modified Date');
  return entry.modified.getTime();
}

function assertModified(got, dumped, label) {
  assert.equal(modifiedMs(got), dumped.modifiedUnixMilli, `${label} modified UnixMilli`);
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment`);
}

test('Go fixture zip entries: extract modified Date matches FileHeader.Modified UnixMilli', () => {
  const packet = loadFixtures();
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(zipCases.length >= 10, zipCases.length);

  let sawZeroDos = false;
  let sawExtraTime = false;
  for (const c of zipCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const got = zipExtract(raw);
    const dumped = goDump(raw) ?? [];
    assert.equal(got.length, dumped.length, `${c.id} entry count`);

    for (let i = 0; i < dumped.length; i++) {
      const label = `${c.id}[${i}]`;
      assert.equal(got[i].name, dumped[i].name, `${label} name`);
      assert.equal(dumped[i].modifiedIsZero, false, `${label} Go Modified is not time zero`);
      assertModified(got[i], dumped[i], label);
    }

    const streamed = streamExtract(raw);
    assert.equal(streamed.length, got.length, `${c.id} stream count`);
    for (let i = 0; i < got.length; i++) {
      assert.equal(modifiedMs(streamed[i]), modifiedMs(got[i]), `${c.id}[${i}] stream modified`);
      assert.equal(streamed[i].atime, undefined, `${c.id}[${i}] stream no atime`);
      assert.equal(streamed[i].ctime, undefined, `${c.id}[${i}] stream no ctime`);
    }
    if (c.id === 'zip-zip64-crafted') {
      sawZeroDos = true;
      assert.equal(modifiedMs(got[0]), Date.UTC(1979, 10, 30), 'zip64 DOS 0/0 → 1979-11-30 UTC');
    }
    if (c.id === 'zip-deflate' && dumped[0].modifiedUnixMilli !== Date.UTC(1979, 10, 30)) {
      sawExtraTime = true;
    }
  }
  assert.ok(sawZeroDos, 'fixtures include zip-zip64-crafted');
  void sawExtraTime;
});

test('Go-written zip with Modified extra timestamp extracts field-level vs FileHeader.UnixMilli', () => {
  const unix = 1_700_000_000;
  const zip = goWrite([
    { name: 's.txt', method: 0, data: 'store-payload', modifiedUnix: unix },
    { name: 'd.txt', method: 8, data: 'deflate payload now', modifiedUnix: unix + 2 },
    { name: 'empty', method: 0, data: '', modifiedUnix: unix },
    { name: 'c.txt', method: 8, comment: 'entry', data: 'c', modifiedUnix: unix },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 4);
  for (let i = 0; i < dumped.length; i++) {
    assertModified(got[i], dumped[i], `go-write[${i}]`);
  }
  assert.equal(modifiedMs(got[0]), unix * 1000);
  assert.equal(modifiedMs(got[1]), (unix + 2) * 1000);
  assert.equal(got.comment, undefined);
});

test('Go-written zip without Modified (DOS 0/0) matches FileHeader.UnixMilli 1979-11-30', () => {
  const zip = goWrite([
    { name: 'now.txt', method: 0, data: 'x' },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 1);
  assertModified(got[0], dumped[0], 'go-write-zero');
  assert.equal(modifiedMs(got[0]), Date.UTC(1979, 10, 30));
  assert.equal(dumped[0].modifiedUnixMilli, Date.UTC(1979, 10, 30));
});

test('zipCreate/ZipWriter modified Date round-trip vs Go FileHeader.UnixMilli (second precision)', () => {
  const t = new Date(Date.UTC(2024, 0, 15, 12, 30, 44));
  const data = new TextEncoder().encode('mtime-payload');
  const zip = zipCreate([
    { name: 'm.txt', method: 8, data, modified: t },
    { name: 'n.txt', method: 0, data: new Uint8Array() },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(Buffer.from(zip));
  assert.equal(got.length, 2);
  assert.equal(modifiedMs(got[0]), t.getTime());
  assertModified(got[0], dumped[0], 'create[0]');
  assertModified(got[1], dumped[1], 'create[1]');

  const w = new ZipWriter();
  w.writeHeader({ name: 'w.txt', method: 8, data, size: data.length, modified: t });
  w.write(data);
  const writerZip = w.end();
  const fromWriter = zipExtract(writerZip);
  const dumpedW = goDump(Buffer.from(writerZip));
  assert.equal(modifiedMs(fromWriter[0]), t.getTime());
  assertModified(fromWriter[0], dumpedW[0], 'writer');
});

test('zip-zip64-crafted modified matches Go; no atime/ctime Date; no archive comment API', () => {
  const packet = loadFixtures();
  const c = packet.cases.find((x) => x.id === 'zip-zip64-crafted');
  assert.ok(c);
  const raw = Buffer.from(c.archiveHex, 'hex');
  const got = zipExtract(raw);
  const dumped = goDump(raw);
  assert.equal(got.length, 1);
  assertModified(got[0], dumped[0], 'zip64');
  assert.equal(modifiedMs(got[0]), Date.UTC(1979, 10, 30));
  assert.equal(Object.hasOwn(got, 'comment'), false);
});
