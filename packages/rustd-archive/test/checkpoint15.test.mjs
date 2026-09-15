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
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
)

type dumpEntry struct {
	Name     string \`json:"name"\`
	NameHex  string \`json:"nameHex"\`
	Method   uint16 \`json:"method"\`
	Comment  string \`json:"comment"\`
	NonUTF8  bool   \`json:"nonUtf8"\`
	Flags    uint16 \`json:"flags"\`
}

type writeEntry struct {
	Name       string \`json:"name"\`
	NameHex    string \`json:"nameHex"\`
	Method     uint16 \`json:"method"\`
	Comment    string \`json:"comment"\`
	Data       string \`json:"data"\`
	NonUTF8    bool   \`json:"nonUtf8"\`
	SetNonUTF8 bool   \`json:"setNonUtf8"\`
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
			NameHex: hex.EncodeToString([]byte(f.Name)),
			Method:  f.Method,
			Comment: f.Comment,
			NonUTF8: f.NonUTF8,
			Flags:   f.Flags,
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
		name := e.Name
		if e.NameHex != "" {
			b, err := hex.DecodeString(e.NameHex)
			fail(err)
			name = string(b)
		}
		hdr := &zip.FileHeader{Name: name, Method: e.Method, Comment: e.Comment}
		if e.SetNonUTF8 {
			hdr.NonUTF8 = e.NonUTF8
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp15-'));
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

function jsNonUtf8(entry) {
  return entry.nonUtf8 === true;
}

function assertNonUtf8(got, dumped, label) {
  assert.equal(jsNonUtf8(got), dumped.nonUtf8 === true, `${label} nonUtf8 vs FileHeader.NonUTF8`);
  assert.equal(got.method === 0 || got.method === 8, true, `${label} method stays 0|8`);
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment`);
  assert.equal(got.extra, undefined, `${label} no extra field`);
}

test('Go fixture zip entries: extract nonUtf8 matches FileHeader.NonUTF8', () => {
  const packet = loadFixtures();
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(zipCases.length >= 10, zipCases.length);

  let sawAsciiFalse = false;
  let sawMultibyteUtf8 = false;
  for (const c of zipCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const got = zipExtract(raw);
    const dumped = goDump(raw) ?? [];
    assert.equal(got.length, dumped.length, `${c.id} entry count`);

    for (let i = 0; i < dumped.length; i++) {
      const label = `${c.id}[${i}]`;
      assert.equal(got[i].name, dumped[i].name, `${label} name`);
      assertNonUtf8(got[i], dumped[i], label);
      if (c.entries?.[i]?.nonUtf8 != null) {
        assert.equal(jsNonUtf8(got[i]), c.entries[i].nonUtf8 === true, `${label} vs fixture`);
      }
      if (dumped[i].nonUtf8 !== true) sawAsciiFalse = true;
      if (/[^\x00-\x7f]/.test(got[i].name)) {
        sawMultibyteUtf8 = true;
        assert.equal(dumped[i].nonUtf8, false, `${label} Go-written multibyte UTF-8 is NonUTF8=false`);
      }
    }

    const streamed = streamExtract(raw);
    assert.equal(streamed.length, got.length, `${c.id} stream count`);
    for (let i = 0; i < got.length; i++) {
      assert.equal(jsNonUtf8(streamed[i]), jsNonUtf8(got[i]), `${c.id}[${i}] stream nonUtf8`);
      assert.equal(streamed[i].atime, undefined, `${c.id}[${i}] stream no atime`);
      assert.equal(streamed[i].ctime, undefined, `${c.id}[${i}] stream no ctime`);
      assert.equal(streamed[i].extra, undefined, `${c.id}[${i}] stream no extra`);
    }
  }
  assert.ok(sawAsciiFalse, 'fixtures include ASCII NonUTF8=false');
  assert.ok(sawMultibyteUtf8, 'fixtures include café-style multibyte name');
});

test('Go-written zip NonUTF8 extracts field-level vs FileHeader.NonUTF8', () => {
  const cafe = 'café.txt';
  const invalidHex = Buffer.from([0xff, 0xfe, 0x41, 0x2e, 0x74, 0x78, 0x74]).toString('hex');
  const zip = goWrite([
    { name: 'ascii.txt', method: 0, data: 'hi' },
    { name: cafe, method: 8, data: 'utf8' },
    { name: cafe, method: 0, data: 'forced', setNonUtf8: true, nonUtf8: true },
    { nameHex: invalidHex, method: 0, data: 'raw', setNonUtf8: true, nonUtf8: true },
    { name: 'c.txt', method: 8, comment: 'entry', data: 'c' },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(zip);
  assert.equal(got.length, 5);
  assert.equal(jsNonUtf8(got[0]), false, 'ASCII stays NonUTF8=false even without bit 11');
  assert.equal(jsNonUtf8(got[1]), false, 'café with UTF-8 flag is NonUTF8=false');
  assert.equal(jsNonUtf8(got[2]), true, 'café with NonUTF8 write is NonUTF8=true');
  assert.equal(jsNonUtf8(got[3]), true, 'invalid name bytes are NonUTF8=true');
  assert.ok(got[3].rawName instanceof Uint8Array, 'invalid name keeps rawName');
  assert.deepEqual(Array.from(got[3].rawName), [0xff, 0xfe, 0x41, 0x2e, 0x74, 0x78, 0x74]);
  for (let i = 0; i < dumped.length; i++) {
    assertNonUtf8(got[i], dumped[i], `go-write[${i}]`);
  }
  assert.equal(got.comment, undefined);
});

test('zipCreate/ZipWriter nonUtf8 round-trip vs Go FileHeader.NonUTF8; no extra/archive comment', () => {
  const rawName = Uint8Array.from([0xff, 0xfe, 0x41, 0x2e, 0x74, 0x78, 0x74]);
  const zip = zipCreate([
    { name: 's.txt', method: 0, data: new TextEncoder().encode('store-me') },
    { name: 'café.txt', method: 8, data: new TextEncoder().encode('deflate payload') },
    { name: 'ignored.txt', method: 0, data: new TextEncoder().encode('raw'), nonUtf8: true, rawName },
  ]);
  const got = zipExtract(zip);
  const dumped = goDump(Buffer.from(zip));
  assert.equal(got.length, 3);
  assert.equal(jsNonUtf8(got[0]), false);
  assert.equal(jsNonUtf8(got[1]), false);
  assert.equal(jsNonUtf8(got[2]), true);
  assert.deepEqual(Array.from(got[2].rawName), Array.from(rawName));
  for (let i = 0; i < dumped.length; i++) {
    assertNonUtf8(got[i], dumped[i], `create[${i}]`);
  }

  const w = new ZipWriter();
  const payload = new TextEncoder().encode('writer-bytes');
  w.writeHeader({ name: 'w-café.txt', method: 8, data: payload, size: payload.length });
  w.write(payload);
  const writerZip = w.end();
  const fromWriter = zipExtract(writerZip);
  const dumpedW = goDump(Buffer.from(writerZip));
  assert.equal(jsNonUtf8(fromWriter[0]), false);
  assertNonUtf8(fromWriter[0], dumpedW[0], 'writer');
});

test('zip-zip64-crafted ASCII+UTF8-flag is NonUTF8=false; no atime/ctime/extra/archive comment', () => {
  const packet = loadFixtures();
  const c = packet.cases.find((x) => x.id === 'zip-zip64-crafted');
  assert.ok(c);
  const raw = Buffer.from(c.archiveHex, 'hex');
  const got = zipExtract(raw);
  const dumped = goDump(raw);
  assert.equal(got.length, 1);
  assert.equal(jsNonUtf8(got[0]), false);
  assertNonUtf8(got[0], dumped[0], 'zip64');
  assert.equal(Object.hasOwn(got, 'comment'), false);
});
