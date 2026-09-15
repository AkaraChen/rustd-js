import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSpawnSync as spawnSync, goExecutable } from '../../../scripts/native-test-tools.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipCreate, zipExtract, ZipFormatError, ZipReader } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const GO_SRC = `package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
)

func fail(err error) {
	if err == nil {
		return
	}
	os.Stderr.WriteString(err.Error() + "\\n")
	os.Exit(1)
}

func open() {
	raw, err := io.ReadAll(os.Stdin)
	fail(err)
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		os.Stdout.WriteString("err\\n")
		return
	}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			os.Stdout.WriteString("err\\n")
			return
		}
		_, err = io.Copy(io.Discard, rc)
		rc.Close()
		if err != nil {
			os.Stdout.WriteString("err\\n")
			return
		}
	}
	os.Stdout.WriteString("ok\\n")
}

type writeEntry struct {
	Name    string \`json:"name"\`
	Method  uint16 \`json:"method"\`
	Comment string \`json:"comment"\`
	Data    string \`json:"data"\`
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
		os.Stderr.WriteString("usage: goinspect open|write\\n")
		os.Exit(1)
	}
	switch os.Args[1] {
	case "open":
		open()
	case "write":
		writeZip()
	default:
		os.Stderr.WriteString("usage: goinspect open|write\\n")
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp18-'));
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

function goOpen(zipBytes) {
  const dir = compileInspect();
  const result = spawnSync(join(dir, goExecutable('goinspect')), ['open'], {
    input: zipBytes,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`goopen exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim() === 'ok';
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

function assertZipFormatError(err, label) {
  assert.ok(err instanceof ZipFormatError, `${label}: ${err?.name ?? err} ${err?.message ?? ''}`);
  assert.equal(err.code, 'ERR_ZIP_FORMAT', `${label} code`);
  assert.equal(typeof err.offset, 'number', `${label} offset`);
  assert.ok(Number.isFinite(err.offset) && err.offset >= 0, `${label} offset=${err.offset}`);
}

function extractThrows(buf, label) {
  let err;
  try {
    zipExtract(buf);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label} did not throw`);
  assertZipFormatError(err, label);
  return err;
}

function streamThrows(buf, label) {
  const reader = new ZipReader();
  reader.on('entry', () => {
    throw new Error(`${label} ZipReader emitted entry on truncated/evil zip`);
  });
  const zip = buf instanceof Uint8Array ? buf : Uint8Array.from(buf);
  for (let i = 0; i < zip.length; i += 13) reader.write(zip.subarray(i, i + 13));
  let err;
  try {
    reader.end();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label} ZipReader.end did not throw`);
  assertZipFormatError(err, `${label} stream`);
}

function everyPrefixThrows(buf, label) {
  const misses = [];
  for (let n = 0; n < buf.length; n++) {
    try {
      const got = zipExtract(buf.subarray(0, n));
      misses.push({ n, names: got.map((e) => e.name) });
    } catch (err) {
      assertZipFormatError(err, `${label} n=${n}`);
    }
  }
  assert.equal(misses.length, 0, `${label} prefixes that did not throw: ${JSON.stringify(misses)}`);
}

function findEocd(buf) {
  const data = Buffer.from(buf);
  for (let i = data.length - 22; i >= 0; i--) {
    if (data.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = data.readUInt16LE(i + 20);
    if (i + 22 + commentLen === data.length) return i;
  }
  throw new Error('no EOCD');
}

function findCentral(buf) {
  const data = Buffer.from(buf);
  for (let i = 0; i + 46 <= data.length; i++) {
    if (data.readUInt32LE(i) === SIG_CENTRAL) return i;
  }
  throw new Error('no central-directory record');
}

function assertNoInvented(got, label) {
  assert.equal(got.atime, undefined, `${label} no atime Date`);
  assert.equal(got.ctime, undefined, `${label} no ctime Date`);
  assert.equal(got.archiveComment, undefined, `${label} no archive-level comment`);
  assert.equal(got.extra, undefined, `${label} no extra field`);
}

test('every truncated zip prefix throws ZipFormatError (JS store/deflate + ZipReader)', () => {
  const store = zipCreate([
    { name: 's.txt', method: 0, data: new TextEncoder().encode('store-payload'), comment: 'c' },
    { name: 'empty', method: 0, data: new Uint8Array() },
  ]);
  everyPrefixThrows(store, 'js-store');
  extractThrows(new Uint8Array(), 'empty-input');
  streamThrows(store.subarray(0, Math.max(1, store.length - 1)), 'js-store-stream');

  const deflate = zipCreate([
    { name: 'd.txt', method: 8, data: new TextEncoder().encode('deflate payload now') },
    { name: 'folder/', method: 0, data: new Uint8Array() },
  ]);
  everyPrefixThrows(deflate, 'js-deflate');
  streamThrows(deflate.subarray(0, Math.max(1, deflate.length - 7)), 'js-deflate-stream');

  const complete = zipExtract(store);
  assert.equal(complete.length, 2);
  assert.equal(Object.hasOwn(complete, 'comment'), false, 'no archive-level comment on extract');
  assert.equal(complete.archiveComment, undefined);
  assert.equal(complete.extra, undefined);
  for (const e of complete) assertNoInvented(e, e.name);
});

test('every truncated prefix of Go-written zip is ZipFormatError; Go Open also rejects', () => {
  const zip = goWrite([
    { name: 's.txt', method: 0, data: 'store-payload' },
    { name: 'd.txt', method: 8, comment: 'entry-note', data: 'deflate payload now' },
  ]);
  assert.equal(goOpen(zip), true, 'complete Go zip opens');
  everyPrefixThrows(zip, 'go-write');
  const cut = zip.subarray(0, zip.length - 1);
  assert.equal(goOpen(cut), false, 'Go rejects truncated zip');
  streamThrows(cut, 'go-write-stream');
});

test('Go fixture zips: truncated prefixes throw ZipFormatError', () => {
  const packet = loadFixtures();
  const zipCases = packet.cases.filter((c) => c.kind === 'zip');
  assert.ok(zipCases.length >= 10, zipCases.length);
  let saw = 0;
  for (const c of zipCases.slice(0, 8)) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    if (raw.length < 22) continue;
    saw += 1;
    everyPrefixThrows(raw, c.id);
    const cut = raw.subarray(0, raw.length - 1);
    assert.equal(goOpen(cut), false, `${c.id} Go rejects truncated`);
  }
  assert.ok(saw >= 4, `checked ${saw} fixture zips`);
});

test('EOCD central-directory offset past EOF is ZipFormatError (not OOB read)', () => {
  const zip = zipCreate([{ name: 't', method: 0, data: new Uint8Array([1]), comment: 'n' }]);
  const offsets = [0xffffffff, 0x7fffffff, zip.length, zip.length + 1, zip.length + 1024];
  for (const off of offsets) {
    const evil = Buffer.from(zip);
    const eocd = findEocd(evil);
    evil.writeUInt32LE(off >>> 0, eocd + 16);
    assert.equal(goOpen(evil), false, `Go Open rejects EOCD offset=${off}`);
    const err = extractThrows(evil, `eocd-off=${off}`);
    assert.equal(err.extra, undefined);
    assert.equal(err.atime, undefined);
    streamThrows(evil, `eocd-off=${off}`);
  }
});

test('central-directory local-header offset past EOF is ZipFormatError (issue #2 §4.5)', () => {
  const zip = zipCreate([
    { name: 't', method: 0, data: new Uint8Array([1, 2, 3]) },
    { name: 'u.txt', method: 8, data: new TextEncoder().encode('x') },
  ]);
  const offsets = [0x7fffffff, zip.length, zip.length + 4096, 0xfffffffe];
  for (const off of offsets) {
    const evil = Buffer.from(zip);
    const cd = findCentral(evil);
    evil.writeUInt32LE(off >>> 0, cd + 42);
    assert.equal(goOpen(evil), false, `Go Open rejects CD local offset=${off}`);
    extractThrows(evil, `cd-local-off=${off}`);
    streamThrows(evil, `cd-local-off=${off}`);
  }

  const goZip = goWrite([{ name: 'g.txt', method: 0, data: 'payload' }]);
  const goEvil = Buffer.from(goZip);
  goEvil.writeUInt32LE(0x7fffffff, findCentral(goEvil) + 42);
  assert.equal(goOpen(goEvil), false);
  extractThrows(goEvil, 'go-cd-local-oob');
});
