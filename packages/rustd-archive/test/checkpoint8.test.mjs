import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tarCreate, tarExtract, TarReader, TarWriter } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const BLOCK = 512;

const GO_DUMP = `package main

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
	Pax              map[string]string \`json:"pax"\`
	ModTimeUnixMilli int64             \`json:"modTimeUnixMilli"\`
	ModTimeUnix      int64             \`json:"modTimeUnix"\`
	DataHex          string            \`json:"dataHex"\`
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

func main() {
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
			Pax:              pax,
			ModTimeUnixMilli: h.ModTime.UnixMilli(),
			ModTimeUnix:      h.ModTime.Unix(),
			DataHex:          fmtHex(data),
		})
	}
	fail(json.NewEncoder(os.Stdout).Encode(out))
}
`;

let dumpBin;

function goCmd() {
  if (process.env.RUSTD_GO === 'path') return { command: 'go', prefix: [] };
  return { command: 'mise', prefix: ['exec', '--', 'go'] };
}

function compileDump() {
  if (dumpBin) return dumpBin;
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp8-'));
  writeFileSync(join(dir, 'main.go'), GO_DUMP);
  const { command, prefix } = goCmd();
  const result = spawnSync(command, [...prefix, 'build', '-o', 'godump', 'main.go'], {
    cwd: dir, encoding: 'utf8', timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`go build godump exited ${result.status}: ${result.stderr}`);
  }
  dumpBin = join(dir, 'godump');
  return dumpBin;
}

function goDump(tarBytes) {
  const result = spawnSync(compileDump(), [], {
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

function loadFixtures() {
  const { command, prefix } = goCmd();
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', '-pkg', 'archive'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Go fixtures exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function parseOctal(buf) {
  const s = buf.toString('latin1').replace(/\0/g, ' ').trim();
  if (!s) return 0;
  return Number.parseInt(s, 8);
}

function paxMaps(tarBytes) {
  const buf = Buffer.from(tarBytes);
  const maps = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const block = buf.subarray(off, off + BLOCK);
    if (block.every((b) => b === 0)) break;
    const size = parseOctal(block.subarray(124, 136));
    const flag = String.fromCharCode(block[156]);
    off += BLOCK;
    const payload = buf.subarray(off, off + size);
    const pad = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
    off += size + pad;
    if (flag === 'x' || flag === 'g') {
      const rec = {};
      let s = payload.toString('utf8');
      while (s.length) {
        const sp = s.indexOf(' ');
        const nStr = s.slice(0, sp);
        const n = Number.parseInt(nStr, 10);
        const recText = s.slice(nStr.length + 1, n);
        const eq = recText.indexOf('=');
        rec[recText.slice(0, eq)] = recText.slice(eq + 1).replace(/\n$/, '');
        s = s.slice(n);
      }
      maps.push(rec);
    }
  }
  return maps;
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

test('Go fixture tar entries: extract mtime UnixMilli matches Go ModTime', () => {
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
      assert.equal(filesGot[i].name, dumped[i].name, `${c.id}[${i}] name`);
      assert.ok(filesGot[i].mtime instanceof Date, `${c.id}[${i}] mtime is Date`);
      assert.equal(filesGot[i].atime, undefined, `${c.id}[${i}] no atime Date`);
      assert.equal(filesGot[i].ctime, undefined, `${c.id}[${i}] no ctime Date`);
      assert.equal(
        filesGot[i].mtime.getTime(),
        dumped[i].modTimeUnixMilli,
        `${c.id}[${i}] mtime UnixMilli vs Go`,
      );
      const wantUnix = c.entries?.[i]?.mtimeUnix;
      if (wantUnix != null) {
        assert.equal(
          filesGot[i].mtime.getTime(),
          wantUnix * 1000,
          `${c.id}[${i}] mtime vs fixture mtimeUnix`,
        );
      }
    }

    const streamed = streamExtract(raw).filter((e) => e.type !== 'x-global-header');
    assert.equal(streamed.length, filesGot.length, `${c.id} stream count`);
    for (let i = 0; i < filesGot.length; i++) {
      assert.equal(streamed[i].mtime.getTime(), filesGot[i].mtime.getTime(), `${c.id}[${i}] stream mtime`);
    }
  }
});

test('integer-second ustar omits pax mtime; Go ModTime UnixMilli still matches', () => {
  const data = new Uint8Array([7, 8, 9]);
  const mtime = new Date(1_700_000_000_000);
  const tar = tarCreate([{ name: 'int.txt', data, mtime }]);
  const maps = paxMaps(tar);
  assert.equal(maps.length, 0, 'no pax header for integer-second ustar');

  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].mtime.getTime(), mtime.getTime());
  assert.equal(got[0].pax, undefined);
  assert.equal(got[0].atime, undefined);
  assert.equal(got[0].ctime, undefined);

  const dumped = goDump(Buffer.from(tar));
  assert.equal(dumped.length, 1);
  assert.equal(dumped[0].modTimeUnixMilli, mtime.getTime());
  assert.equal(dumped[0].pax.mtime, undefined, 'Go PAXRecords omit mtime');
  assert.equal(dumped[0].modTimeUnix, 1_700_000_000);
});

test('integer-second mtime with extra pax keys still omits pax mtime', () => {
  const tar = tarCreate([{
    name: 'p.txt',
    data: Buffer.from('p'),
    mtime: new Date(1_700_000_000_000),
    pax: { comment: 'keep', atime: '1700000001' },
  }]);
  const maps = paxMaps(tar);
  assert.ok(maps.length >= 1);
  for (const rec of maps) {
    assert.equal(rec.mtime, undefined, 'pax mtime omitted when ustar seconds suffice');
  }
  const got = tarExtract(tar);
  assert.equal(got[0].mtime.getTime(), 1_700_000_000_000);
  assert.equal(got[0].pax.comment, 'keep');
  assert.equal(got[0].pax.atime, '1700000001');
  assert.equal(got[0].pax.mtime, undefined);
  assert.equal(got[0].atime, undefined);

  const dumped = goDump(Buffer.from(tar));
  assert.equal(dumped[0].modTimeUnixMilli, 1_700_000_000_000);
  assert.equal(dumped[0].pax.mtime, undefined);
  assert.equal(dumped[0].pax.comment, 'keep');
});

test('TarWriter integer-second mtime omits pax mtime like tarCreate', () => {
  const data = new TextEncoder().encode('w');
  const mtime = new Date(0);
  const w = new TarWriter();
  w.writeHeader({ name: 'z.txt', data, mtime, size: data.length });
  w.write(data);
  const tar = w.end();
  assert.equal(paxMaps(tar).length, 0);
  const got = tarExtract(tar);
  assert.equal(got[0].mtime.getTime(), 0);
  const dumped = goDump(Buffer.from(tar));
  assert.equal(dumped[0].modTimeUnixMilli, 0);
  assert.equal(dumped[0].pax.mtime, undefined);
});
