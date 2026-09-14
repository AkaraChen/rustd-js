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
	Mode             int64             \`json:"mode"\`
	Uid              int               \`json:"uid"\`
	Gid              int               \`json:"gid"\`
	Pax              map[string]string \`json:"pax"\`
	ModTimeUnixMilli int64             \`json:"modTimeUnixMilli"\`
	DataHex          string            \`json:"dataHex"\`
}

type writeEntry struct {
	Name string \`json:"name"\`
	Mode int64  \`json:"mode"\`
	Uid  int    \`json:"uid"\`
	Gid  int    \`json:"gid"\`
	Data string \`json:"data"\`
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
			Mode:             h.Mode,
			Uid:              h.Uid,
			Gid:              h.Gid,
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
			Name: e.Name,
			Size: int64(len(data)),
			Mode: e.Mode,
			Uid:  e.Uid,
			Gid:  e.Gid,
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp9-'));
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

function assertIds(got, dumped, label) {
  assert.equal(got.uid ?? 0, dumped.uid, `${label} uid`);
  assert.equal(got.gid ?? 0, dumped.gid, `${label} gid`);
  if (dumped.uid === 0) assert.equal(got.uid, undefined, `${label} omit zero uid`);
  if (dumped.gid === 0) assert.equal(got.gid, undefined, `${label} omit zero gid`);
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

function tarHeader({ name, typeflag = '0', size, mode = 0o644, uid = 0, gid = 0 }) {
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

function paxTar({ records, fileName, fileData, uid = 0, gid = 0, mode = 0o644 }) {
  const body = paxBody(records);
  return Buffer.concat([
    tarHeader({ name: `./PaxHeaders.0/${fileName}`.slice(0, 100), typeflag: 'x', size: body.length, mode: 0 }),
    body,
    Buffer.alloc(pad512(body.length)),
    tarHeader({ name: fileName, typeflag: '0', size: fileData.length, uid, gid, mode }),
    fileData,
    Buffer.alloc(pad512(fileData.length)),
    Buffer.alloc(BLOCK),
    Buffer.alloc(BLOCK),
  ]);
}

test('Go fixture tar entries: extract mode/uid/gid match Go Header', () => {
  const packet = loadFixtures();
  const tarCases = packet.cases.filter((c) => c.kind === 'tar');
  assert.ok(tarCases.length >= 10, tarCases.length);

  let sawNonDefaultMode = false;
  for (const c of tarCases) {
    const raw = Buffer.from(c.archiveHex, 'hex');
    const got = tarExtract(raw);
    const dumped = goDump(raw) ?? [];
    const filesGot = got.filter((e) => e.type !== 'x-global-header');
    assert.equal(filesGot.length, dumped.length, `${c.id} entry count`);

    for (let i = 0; i < dumped.length; i++) {
      const label = `${c.id}[${i}]`;
      assert.equal(filesGot[i].name, dumped[i].name, `${label} name`);
      assert.equal(filesGot[i].mode, dumped[i].mode, `${label} mode vs Go`);
      assertIds(filesGot[i], dumped[i], label);
      assert.equal(filesGot[i].atime, undefined, `${label} no atime Date`);
      assert.equal(filesGot[i].ctime, undefined, `${label} no ctime Date`);
      const wantMode = c.entries?.[i]?.mode;
      if (wantMode != null) {
        assert.equal(filesGot[i].mode, wantMode, `${label} mode vs fixture`);
        if (wantMode !== 0o644) sawNonDefaultMode = true;
      }
    }

    const streamed = streamExtract(raw).filter((e) => e.type !== 'x-global-header');
    assert.equal(streamed.length, filesGot.length, `${c.id} stream count`);
    for (let i = 0; i < filesGot.length; i++) {
      assert.equal(streamed[i].mode, filesGot[i].mode, `${c.id}[${i}] stream mode`);
      assert.equal(streamed[i].uid, filesGot[i].uid, `${c.id}[${i}] stream uid`);
      assert.equal(streamed[i].gid, filesGot[i].gid, `${c.id}[${i}] stream gid`);
    }
  }
  assert.ok(sawNonDefaultMode, 'fixtures include at least one non-0644 mode');
});

test('Go-written non-zero uid/gid extract field-level vs Go Header', () => {
  const tar = goWrite([
    { name: 'u.txt', mode: 0o640, uid: 1000, gid: 100, data: 'owner' },
    { name: 'root.txt', mode: 0o600, uid: 0, gid: 0, data: 'root' },
  ]);
  const got = tarExtract(tar);
  const dumped = goDump(tar);
  assert.equal(got.length, 2);
  assert.equal(got[0].mode, 0o640);
  assert.equal(got[0].uid, 1000);
  assert.equal(got[0].gid, 100);
  assert.equal(got[1].mode, 0o600);
  assert.equal(got[1].uid, undefined);
  assert.equal(got[1].gid, undefined);
  for (let i = 0; i < dumped.length; i++) {
    assert.equal(got[i].mode, dumped[i].mode, `go-write[${i}] mode`);
    assertIds(got[i], dumped[i], `go-write[${i}]`);
    assert.equal(got[i].atime, undefined);
    assert.equal(got[i].ctime, undefined);
  }
});

test('tarCreate uid/gid/mode round-trip matches Go Header; zero ids omitted', () => {
  const data = new Uint8Array([1, 2, 3]);
  const tar = tarCreate([
    { name: 'a.txt', data, mode: 0o755, uid: 7, gid: 8 },
    { name: 'b.txt', data, mode: 0o644 },
  ]);
  const got = tarExtract(tar);
  const dumped = goDump(Buffer.from(tar));
  assert.equal(got[0].mode, 0o755);
  assert.equal(got[0].uid, 7);
  assert.equal(got[0].gid, 8);
  assert.equal(got[1].mode, 0o644);
  assert.equal(got[1].uid, undefined);
  assert.equal(got[1].gid, undefined);
  for (let i = 0; i < dumped.length; i++) {
    assert.equal(got[i].mode, dumped[i].mode);
    assertIds(got[i], dumped[i], `create[${i}]`);
  }

  const w = new TarWriter();
  const payload = new TextEncoder().encode('w');
  w.writeHeader({ name: 'w.txt', data: payload, size: payload.length, mode: 0o711, uid: 42, gid: 99 });
  w.write(payload);
  const writerTar = w.end();
  const fromWriter = tarExtract(writerTar);
  const dumpedW = goDump(Buffer.from(writerTar));
  assert.equal(fromWriter[0].mode, 0o711);
  assert.equal(fromWriter[0].uid, 42);
  assert.equal(fromWriter[0].gid, 99);
  assert.equal(fromWriter[0].mode, dumpedW[0].mode);
  assertIds(fromWriter[0], dumpedW[0], 'writer');
});

test('pax uid/gid override ustar fields and match Go; atime/ctime stay off Date', () => {
  const data = Buffer.from('pax-ids');
  const tar = paxTar({
    records: { uid: '3000000', gid: '4000000', atime: '1700000001', ctime: '1700000002' },
    fileName: 'p.txt',
    fileData: data,
    uid: 1,
    gid: 2,
    mode: 0o640,
  });
  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].mode, 0o640);
  assert.equal(got[0].uid, 3_000_000);
  assert.equal(got[0].gid, 4_000_000);
  assert.equal(got[0].atime, undefined);
  assert.equal(got[0].ctime, undefined);
  assert.equal(got[0].pax.atime, '1700000001');
  assert.equal(got[0].pax.ctime, '1700000002');

  const dumped = goDump(tar);
  assert.equal(dumped.length, 1);
  assert.equal(got[0].mode, dumped[0].mode);
  assertIds(got[0], dumped[0], 'pax-ids');
  assert.equal(dumped[0].uid, 3_000_000);
  assert.equal(dumped[0].gid, 4_000_000);
  assert.equal(dumped[0].pax.atime, '1700000001');
  assert.equal(dumped[0].pax.ctime, '1700000002');

  const streamed = streamExtract(tar);
  assert.equal(streamed[0].uid, 3_000_000);
  assert.equal(streamed[0].gid, 4_000_000);
  assert.equal(streamed[0].mode, 0o640);
  assert.equal(streamed[0].atime, undefined);
  assert.equal(streamed[0].ctime, undefined);
});
