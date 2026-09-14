import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tarCreate, tarExtract, TarReader, TarWriter } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const BLOCK = 512;

const GO_SRC = `package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"os"
)

type dumpEntry struct {
	Name             string            \`json:"name"\`
	Typeflag         string            \`json:"typeflag"\`
	Uname            string            \`json:"uname"\`
	Gname            string            \`json:"gname"\`
	Pax              map[string]string \`json:"pax"\`
	ModTimeUnixMilli int64             \`json:"modTimeUnixMilli"\`
	DataHex          string            \`json:"dataHex"\`
}

type writeEntry struct {
	Name  string \`json:"name"\`
	Uname string \`json:"uname"\`
	Gname string \`json:"gname"\`
	Data  string \`json:"data"\`
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
	r := tar.NewReader(bytes.NewReader(raw))
	out := []dumpEntry{}
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
			Name:             h.Name,
			Typeflag:         string([]byte{h.Typeflag}),
			Uname:            h.Uname,
			Gname:            h.Gname,
			Pax:              pax,
			ModTimeUnixMilli: h.ModTime.UnixMilli(),
			DataHex:          fmtHex(data),
		})
	}
	fail(json.NewEncoder(os.Stdout).Encode(out))
}

func writeTar() {
	var entries []writeEntry
	fail(json.NewDecoder(os.Stdin).Decode(&entries))
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	for _, e := range entries {
		data := []byte(e.Data)
		hdr := &tar.Header{
			Name:  e.Name,
			Size:  int64(len(data)),
			Mode:  0o644,
			Uname: e.Uname,
			Gname: e.Gname,
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
		os.Stderr.WriteString("usage: goinspect dump|write\\n")
		os.Exit(1)
	}
	switch os.Args[1] {
	case "dump":
		dump()
	case "write":
		writeTar()
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp10-'));
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

function goDump(tarBytes) {
  const dir = compileInspect();
  const result = spawnSync(join(dir, 'goinspect'), ['dump'], {
    input: tarBytes,
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

function streamExtract(tarBytes) {
  const chunked = [];
  const reader = new TarReader();
  reader.on('entry', (e) => chunked.push(e));
  const tar = tarBytes instanceof Uint8Array ? tarBytes : Uint8Array.from(tarBytes);
  for (let i = 0; i < tar.length; i += 23) reader.write(tar.subarray(i, i + 23));
  reader.end();
  return chunked;
}

function assertNames(got, dumped, label) {
  assert.equal(got.uname ?? '', dumped.uname, `${label} uname`);
  assert.equal(got.gname ?? '', dumped.gname, `${label} gname`);
  if (!dumped.uname) assert.equal(got.uname, undefined, `${label} omit empty uname`);
  if (!dumped.gname) assert.equal(got.gname, undefined, `${label} omit empty gname`);
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

function cstringField(width, value) {
  const buf = Buffer.alloc(width, 0);
  Buffer.from(value).copy(buf, 0, 0, width - 1);
  return buf;
}

function tarHeader({ name, typeflag = '0', size, mode = 0o644, uid = 0, gid = 0, uname = '', gname = '' }) {
  const b = Buffer.alloc(BLOCK);
  Buffer.from(name).copy(b, 0, 0, 100);
  octalField(8, mode).copy(b, 100);
  octalField(8, uid).copy(b, 108);
  octalField(8, gid).copy(b, 116);
  octalField(12, size).copy(b, 124);
  octalField(12, 0).copy(b, 136);
  b.fill(0x20, 148, 156);
  b[156] = typeflag.charCodeAt(0);
  b.write('ustar\0', 257);
  b[263] = 0x30;
  b[264] = 0x30;
  cstringField(32, uname).copy(b, 265);
  cstringField(32, gname).copy(b, 297);
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

function paxTar({ records, fileName, fileData, uname = '', gname = '' }) {
  const body = paxBody(records);
  return Buffer.concat([
    tarHeader({ name: `./PaxHeaders.0/${fileName}`.slice(0, 100), typeflag: 'x', size: body.length, mode: 0 }),
    body,
    Buffer.alloc(pad512(body.length)),
    tarHeader({ name: fileName, typeflag: '0', size: fileData.length, uname, gname }),
    fileData,
    Buffer.alloc(pad512(fileData.length)),
    Buffer.alloc(BLOCK),
    Buffer.alloc(BLOCK),
  ]);
}

test('Go fixture tar entries: extract uname/gname match Go Header', () => {
  const packet = loadFixtures();
  const tarCases = packet.cases.filter((c) => c.kind === 'tar');
  assert.ok(tarCases.length >= 10, tarCases.length);

  for (const c of tarCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const got = tarExtract(raw);
    const dumped = goDump(raw) ?? [];
    const filesGot = got.filter((e) => e.type !== 'x-global-header');
    assert.equal(filesGot.length, dumped.length, `${c.id} entry count`);

    for (let i = 0; i < dumped.length; i++) {
      const label = `${c.id}[${i}]`;
      assert.equal(filesGot[i].name, dumped[i].name, `${label} name`);
      assertNames(filesGot[i], dumped[i], label);
      assert.equal(filesGot[i].atime, undefined, `${label} no atime Date`);
      assert.equal(filesGot[i].ctime, undefined, `${label} no ctime Date`);
    }

    const streamed = streamExtract(raw).filter((e) => e.type !== 'x-global-header');
    assert.equal(streamed.length, filesGot.length, `${c.id} stream count`);
    for (let i = 0; i < filesGot.length; i++) {
      assert.equal(streamed[i].uname, filesGot[i].uname, `${c.id}[${i}] stream uname`);
      assert.equal(streamed[i].gname, filesGot[i].gname, `${c.id}[${i}] stream gname`);
    }
  }
});

test('Go-written uname/gname extract field-level vs Go Header', () => {
  const tar = goWrite([
    { name: 'u.txt', uname: 'alice', gname: 'staff', data: 'owner' },
    { name: 'root.txt', uname: '', gname: '', data: 'root' },
    { name: 'max.txt', uname: 'u'.repeat(31), gname: 'g'.repeat(31), data: 'max' },
  ]);
  const got = tarExtract(tar);
  const dumped = goDump(tar);
  assert.equal(got.length, 3);
  assert.equal(got[0].uname, 'alice');
  assert.equal(got[0].gname, 'staff');
  assert.equal(got[1].uname, undefined);
  assert.equal(got[1].gname, undefined);
  assert.equal(got[2].uname, 'u'.repeat(31));
  assert.equal(got[2].gname, 'g'.repeat(31));
  for (let i = 0; i < dumped.length; i++) {
    assertNames(got[i], dumped[i], `go-write[${i}]`);
    assert.equal(got[i].atime, undefined);
    assert.equal(got[i].ctime, undefined);
  }
});

test('tarCreate uname/gname round-trip matches Go Header; empty omitted', () => {
  const data = new Uint8Array([1, 2, 3]);
  const tar = tarCreate([
    { name: 'a.txt', data, uname: 'bob', gname: 'wheel' },
    { name: 'b.txt', data },
  ]);
  const got = tarExtract(tar);
  const dumped = goDump(Buffer.from(tar));
  assert.equal(got[0].uname, 'bob');
  assert.equal(got[0].gname, 'wheel');
  assert.equal(got[1].uname, undefined);
  assert.equal(got[1].gname, undefined);
  for (let i = 0; i < dumped.length; i++) {
    assertNames(got[i], dumped[i], `create[${i}]`);
  }

  const w = new TarWriter();
  const payload = new TextEncoder().encode('w');
  w.writeHeader({ name: 'w.txt', data: payload, size: payload.length, uname: 'carol', gname: 'ops' });
  w.write(payload);
  const writerTar = w.end();
  const fromWriter = tarExtract(writerTar);
  const dumpedW = goDump(Buffer.from(writerTar));
  assert.equal(fromWriter[0].uname, 'carol');
  assert.equal(fromWriter[0].gname, 'ops');
  assertNames(fromWriter[0], dumpedW[0], 'writer');
});

test('pax uname/gname override ustar fields and match Go; atime/ctime stay off Date', () => {
  const data = Buffer.from('pax-names');
  const tar = paxTar({
    records: {
      uname: 'paxuser',
      gname: 'paxgroup',
      atime: '1700000001',
      ctime: '1700000002',
    },
    fileName: 'p.txt',
    fileData: data,
    uname: 'ustaruser',
    gname: 'ustargroup',
  });
  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].uname, 'paxuser');
  assert.equal(got[0].gname, 'paxgroup');
  assert.equal(got[0].atime, undefined);
  assert.equal(got[0].ctime, undefined);
  assert.equal(got[0].pax.atime, '1700000001');
  assert.equal(got[0].pax.ctime, '1700000002');

  const dumped = goDump(tar);
  assert.equal(dumped.length, 1);
  assertNames(got[0], dumped[0], 'pax-names');
  assert.equal(dumped[0].uname, 'paxuser');
  assert.equal(dumped[0].gname, 'paxgroup');
  assert.equal(dumped[0].pax.atime, '1700000001');
  assert.equal(dumped[0].pax.ctime, '1700000002');

  const streamed = streamExtract(tar);
  assert.equal(streamed[0].uname, 'paxuser');
  assert.equal(streamed[0].gname, 'paxgroup');
  assert.equal(streamed[0].atime, undefined);
  assert.equal(streamed[0].ctime, undefined);
});

test('pax long uname/gname (>31) extract matches Go Header', () => {
  const longUser = `user_${'x'.repeat(40)}`;
  const longGroup = `group_${'y'.repeat(40)}`;
  const data = Buffer.from('long');
  const tar = paxTar({
    records: { uname: longUser, gname: longGroup },
    fileName: 'long.txt',
    fileData: data,
    uname: 'shortu',
    gname: 'shortg',
  });
  const got = tarExtract(tar);
  const dumped = goDump(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].uname, longUser);
  assert.equal(got[0].gname, longGroup);
  assertNames(got[0], dumped[0], 'pax-long');

  const created = tarCreate([{ name: 'c.txt', data: new Uint8Array([9]), uname: longUser, gname: longGroup }]);
  const createdGot = tarExtract(created);
  const createdDump = goDump(Buffer.from(created));
  assert.equal(createdGot[0].uname, longUser);
  assert.equal(createdGot[0].gname, longGroup);
  assertNames(createdGot[0], createdDump[0], 'create-long');
});
