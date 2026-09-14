import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  tarCreate, tarExtract, TarReader,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const BLOCK = 512;

function goFixtures(args, input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const prefix = command === 'go' ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', ...args], {
    cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Go fixtures exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

const GO_INSPECT = `package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"os"
)

type dumpEntry struct {
	Name     string            \`json:"name"\`
	Typeflag string            \`json:"typeflag"\`
	Pax      map[string]string \`json:"pax"\`
	DataHex  string            \`json:"dataHex"\`
}

type writeEntry struct {
	Name     string            \`json:"name"\`
	Typeflag string            \`json:"typeflag"\`
	Pax      map[string]string \`json:"pax"\`
	Data     string            \`json:"data"\`
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
	r := tar.NewReader(bytes.NewReader(raw))
	var out []dumpEntry
	for {
		h, err := r.Next()
		if err == io.EOF {
			break
		}
		fail(err)
		data, err := io.ReadAll(r)
		fail(err)
		pax := h.PAXRecords
		if pax == nil {
			pax = map[string]string{}
		}
		out = append(out, dumpEntry{
			Name:     h.Name,
			Typeflag: string([]byte{h.Typeflag}),
			Pax:      pax,
			DataHex:  fmtHex(data),
		})
	}
	enc := json.NewEncoder(os.Stdout)
	fail(enc.Encode(out))
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

func writeTar() {
	var entries []writeEntry
	fail(json.NewDecoder(os.Stdin).Decode(&entries))
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	for _, e := range entries {
		data := []byte(e.Data)
		flag := byte('0')
		if e.Typeflag != "" {
			flag = e.Typeflag[0]
		}
		hdr := &tar.Header{
			Name:       e.Name,
			Size:       int64(len(data)),
			Mode:       0o644,
			Typeflag:   flag,
			PAXRecords: e.Pax,
		}
		fail(w.WriteHeader(hdr))
		if len(data) > 0 {
			_, err := w.Write(data)
			fail(err)
		}
	}
	fail(w.Close())
	_, err := os.Stdout.Write(buf.Bytes())
	fail(err)
}

func main() {
	if len(os.Args) < 2 {
		fail(errUsage())
	}
	switch os.Args[1] {
	case "dump":
		dump()
	case "write":
		writeTar()
	default:
		fail(errUsage())
	}
}

type simpleError string

func (e simpleError) Error() string { return string(e) }
func errUsage() error               { return simpleError("usage: goinspect dump|write") }
`;

function goInspect(mode, input) {
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-goinspect-'));
  writeFileSync(join(dir, 'main.go'), GO_INSPECT);
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const prefix = command === 'go' ? [] : ['exec', '--', 'go'];
  const opts = {
    cwd: dir,
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  };
  if (mode === 'dump') opts.encoding = 'utf8';
  const result = spawnSync(command, [...prefix, 'run', 'main.go', mode], opts);
  if (result.status !== 0) {
    throw new Error(`goinspect ${mode} exited ${result.status}: ${result.stderr}`);
  }
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

function paxBody(records) {
  let body = '';
  for (const [k, v] of Object.entries(records)) {
    let size = k.length + v.length + 3;
    size += String(size).length;
    let record = `${size} ${k}=${v}\n`;
    if (record.length !== size) {
      size = record.length;
      record = `${size} ${k}=${v}\n`;
    }
    body += record;
  }
  return Buffer.from(body);
}

function paxTar({ records, typeflag = 'x', fileName, fileData, fileTypeflag = '0' }) {
  const body = paxBody(records);
  const parts = [
    tarHeader({ name: `./PaxHeaders.0/${fileName}`.slice(0, 100), typeflag, size: body.length, mode: 0 }),
    body,
    Buffer.alloc(pad512(body.length)),
    tarHeader({ name: fileName, typeflag: fileTypeflag, size: fileData.length }),
    fileData,
    Buffer.alloc(pad512(fileData.length)),
    Buffer.alloc(BLOCK),
    Buffer.alloc(BLOCK),
  ];
  return Buffer.concat(parts);
}

function unknownTypeTar({ name, typeflag, data }) {
  return Buffer.concat([
    tarHeader({ name, typeflag, size: data.length }),
    data,
    Buffer.alloc(pad512(data.length)),
    Buffer.alloc(BLOCK),
    Buffer.alloc(BLOCK),
  ]);
}

function verifyGoReads(id, tar, entries) {
  const packet = {
    schema: 1,
    package: 'archive',
    cases: [{
      id,
      kind: 'tar',
      archiveHex: Buffer.from(tar).toString('hex'),
      entries,
    }],
  };
  const out = goFixtures(['-pkg', 'archive', '-verify'], JSON.stringify(packet));
  assert.match(out, /Go verified 1 archive cases/);
}

test('unknown pax keys are retained on entry.pax; Go PAXRecords match', () => {
  const data = Buffer.from('hi');
  const pax = {
    'SCHILY.xattr.user.foo': 'bar',
    comment: 'keep-me',
  };
  const tar = tarCreate([{ name: 'f.txt', data, pax }]);
  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'f.txt');
  assert.equal(got[0].type, 'reg');
  assert.deepEqual(got[0].pax, pax);
  equalBytes(got[0].data, data, 'pax file data');

  const dumped = JSON.parse(goInspect('dump', Buffer.from(tar)));
  assert.equal(dumped.length, 1);
  assert.equal(dumped[0].name, 'f.txt');
  assert.equal(dumped[0].typeflag, '0');
  assert.equal(dumped[0].pax['SCHILY.xattr.user.foo'], 'bar');
  assert.equal(dumped[0].pax.comment, 'keep-me');
  assert.equal(dumped[0].dataHex, data.toString('hex'));

  verifyGoReads('pax-unknown-keys', tar, [{ name: 'f.txt', dataHex: data.toString('hex') }]);
});

test('crafted pax x-header unknown keys survive extract and TarReader', () => {
  const data = Buffer.from('payload');
  const records = {
    'LIBARCHIVE.creationtime': '1700000000.5',
    comment: 'crafted',
    path: 'renamed.txt',
  };
  const tar = paxTar({ records, fileName: 'old.txt', fileData: data });
  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'renamed.txt');
  assert.equal(got[0].pax.comment, 'crafted');
  assert.equal(got[0].pax['LIBARCHIVE.creationtime'], '1700000000.5');
  assert.equal(got[0].pax.path, undefined, 'known path key is applied, not duplicated');
  equalBytes(got[0].data, data, 'crafted pax data');

  const chunked = [];
  const reader = new TarReader();
  reader.on('entry', (e) => chunked.push(e));
  for (let i = 0; i < tar.length; i++) reader.write(tar.subarray(i, i + 1));
  reader.end();
  assert.equal(chunked.length, 1);
  assert.equal(chunked[0].name, 'renamed.txt');
  assert.equal(chunked[0].pax.comment, 'crafted');
  equalBytes(chunked[0].data, data, 'stream crafted pax data');

  const dumped = JSON.parse(goInspect('dump', tar));
  assert.equal(dumped[0].name, 'renamed.txt');
  assert.equal(dumped[0].pax.comment, 'crafted');
  assert.equal(dumped[0].pax['LIBARCHIVE.creationtime'], '1700000000.5');
});

test('Go-written PAXRecords unknown keys extract onto entry.pax', () => {
  const tar = goInspect('write', JSON.stringify([{
    name: 'g.txt',
    typeflag: '0',
    pax: { 'SCHILY.xattr.user.go': 'from-go', comment: 'go-pax' },
    data: 'go-hi',
  }]));
  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'g.txt');
  assert.equal(got[0].pax['SCHILY.xattr.user.go'], 'from-go');
  assert.equal(got[0].pax.comment, 'go-pax');
  equalBytes(got[0].data, Buffer.from('go-hi'), 'go-written data');
});

test('unknown typeflag is kept as type string; Go Typeflag matches', () => {
  const cont = Buffer.from('cont');
  const letter = Buffer.from('A');
  const created = tarCreate([
    { name: 'u.bin', type: '7', data: cont },
    { name: 'a.bin', type: 'A', data: letter },
  ]);
  const got = tarExtract(created);
  assert.equal(got[0].type, '7');
  assert.equal(got[0].typeflag, '7');
  assert.equal(got[1].type, 'A');
  assert.equal(got[1].typeflag, 'A');
  equalBytes(got[0].data, cont, 'type 7 data');
  equalBytes(got[1].data, letter, 'type A data');

  const crafted7 = unknownTypeTar({ name: 'raw7', typeflag: '7', data: cont });
  const raw = tarExtract(crafted7);
  assert.equal(raw[0].type, '7');
  assert.equal(raw[0].typeflag, '7');
  assert.equal(raw[0].name, 'raw7');

  const dumped = JSON.parse(goInspect('dump', Buffer.from(created)));
  assert.equal(dumped[0].typeflag, '7');
  assert.equal(dumped[1].typeflag, 'A');
  assert.equal(dumped[0].name, 'u.bin');
  assert.equal(dumped[1].name, 'a.bin');

  const fromGo = goInspect('write', JSON.stringify([
    { name: 'go7', typeflag: '7', data: 'cont' },
    { name: 'goA', typeflag: 'A', data: 'A' },
  ]));
  const goGot = tarExtract(fromGo);
  assert.equal(goGot[0].type, '7');
  assert.equal(goGot[0].typeflag, '7');
  assert.equal(goGot[1].type, 'A');
  assert.equal(goGot[1].typeflag, 'A');

  verifyGoReads('unknown-typeflag', created, [
    { name: 'u.bin', dataHex: cont.toString('hex') },
    { name: 'a.bin', dataHex: letter.toString('hex') },
  ]);
});

test('global pax unknown keys are retained on the x-global-header entry', () => {
  const data = Buffer.from('body');
  const tar = paxTar({
    records: { 'SCHILY.xattr.user.global': 'gval', comment: 'global' },
    typeflag: 'g',
    fileName: 'after.txt',
    fileData: data,
  });
  const got = tarExtract(tar);
  const hdr = got.find((e) => e.type === 'x-global-header' || e.typeflag === 'g');
  assert.ok(hdr, 'x-global-header entry present');
  assert.equal(hdr.type, 'x-global-header');
  assert.equal(hdr.typeflag, 'g');
  assert.equal(hdr.pax['SCHILY.xattr.user.global'], 'gval');
  assert.equal(hdr.pax.comment, 'global');
  const file = got.find((e) => e.name === 'after.txt');
  assert.ok(file, 'file entry present');
  equalBytes(file.data, data, 'global-pax file data');

  // Go 1.24 returns TypeXGlobalHeader as its own Next() entry with PAXRecords
  // and does not merge those records into the following file.
  const dumped = JSON.parse(goInspect('dump', tar));
  const goHdr = dumped.find((e) => e.typeflag === 'g');
  assert.ok(goHdr);
  assert.equal(goHdr.pax['SCHILY.xattr.user.global'], 'gval');
  assert.equal(goHdr.pax.comment, 'global');
  const goFile = dumped.find((e) => e.name === 'after.txt');
  assert.ok(goFile);
  assert.equal(goFile.dataHex, data.toString('hex'));
});
