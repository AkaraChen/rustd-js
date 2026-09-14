import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  tarCreate, tarExtract, TarReader, TarFormatError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const BLOCK = 512;

const GO_INSPECT = `package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"time"
)

type dumpEntry struct {
	Name                string            \`json:"name"\`
	Typeflag            string            \`json:"typeflag"\`
	Pax                 map[string]string \`json:"pax"\`
	ModTimeUnixMilli    int64             \`json:"modTimeUnixMilli"\`
	ModTimeUnixNano     int64             \`json:"modTimeUnixNano"\`
	AccessTimeUnixMilli int64             \`json:"accessTimeUnixMilli"\`
	ChangeTimeUnixMilli int64             \`json:"changeTimeUnixMilli"\`
	AccessZero          bool              \`json:"accessZero"\`
	ChangeZero          bool              \`json:"changeZero"\`
	DataHex             string            \`json:"dataHex"\`
}

type writeEntry struct {
	Name         string            \`json:"name"\`
	Typeflag     string            \`json:"typeflag"\`
	Pax          map[string]string \`json:"pax"\`
	Data         string            \`json:"data"\`
	ModTimeUnix  *int64            \`json:"modTimeUnix"\`
	ModTimeNsec  *int64            \`json:"modTimeNsec"\`
	AccessUnix   *int64            \`json:"accessUnix"\`
	AccessNsec   *int64            \`json:"accessNsec"\`
	ChangeUnix   *int64            \`json:"changeUnix"\`
	ChangeNsec   *int64            \`json:"changeNsec"\`
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
			Name:                h.Name,
			Typeflag:            string([]byte{h.Typeflag}),
			Pax:                 pax,
			ModTimeUnixMilli:    h.ModTime.UnixMilli(),
			ModTimeUnixNano:     h.ModTime.UnixNano(),
			AccessTimeUnixMilli: h.AccessTime.UnixMilli(),
			ChangeTimeUnixMilli: h.ChangeTime.UnixMilli(),
			AccessZero:          h.AccessTime.IsZero(),
			ChangeZero:          h.ChangeTime.IsZero(),
			DataHex:             fmtHex(data),
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
			Format:     tar.FormatPAX,
		}
		if e.ModTimeUnix != nil {
			var nsec int64
			if e.ModTimeNsec != nil {
				nsec = *e.ModTimeNsec
			}
			hdr.ModTime = time.Unix(*e.ModTimeUnix, nsec)
		}
		if e.AccessUnix != nil {
			var nsec int64
			if e.AccessNsec != nil {
				nsec = *e.AccessNsec
			}
			hdr.AccessTime = time.Unix(*e.AccessUnix, nsec)
		}
		if e.ChangeUnix != nil {
			var nsec int64
			if e.ChangeNsec != nil {
				nsec = *e.ChangeNsec
			}
			hdr.ChangeTime = time.Unix(*e.ChangeUnix, nsec)
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp7-'));
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

function tarHeader({ name, typeflag, size, linkname = '', mode = 0o644, mtime = 0 }) {
  const b = Buffer.alloc(BLOCK);
  Buffer.from(name).copy(b, 0, 0, 100);
  octalField(8, mode).copy(b, 100);
  octalField(8, 0).copy(b, 108);
  octalField(8, 0).copy(b, 116);
  octalField(12, size).copy(b, 124);
  octalField(12, mtime).copy(b, 136);
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

function paxTar({ records, fileName, fileData, ustarMtime = 0 }) {
  const body = paxBody(records);
  return Buffer.concat([
    tarHeader({ name: `./PaxHeaders.0/${fileName}`.slice(0, 100), typeflag: 'x', size: body.length, mode: 0 }),
    body,
    Buffer.alloc(pad512(body.length)),
    tarHeader({ name: fileName, typeflag: '0', size: fileData.length, mtime: ustarMtime }),
    fileData,
    Buffer.alloc(pad512(fileData.length)),
    Buffer.alloc(BLOCK),
    Buffer.alloc(BLOCK),
  ]);
}

test('pax mtime fractional seconds match Go ModTime UnixMilli; atime/ctime stay on pax', () => {
  const data = Buffer.from('frac');
  const records = {
    mtime: '1700000000.123456789',
    atime: '1700000001.5',
    ctime: '1700000002.25',
  };
  const tar = paxTar({ records, fileName: 'f.txt', fileData: data, ustarMtime: 1700000000 });
  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'f.txt');
  assert.equal(got[0].mtime.getTime(), 1_700_000_000_123);
  assert.equal(got[0].atime, undefined);
  assert.equal(got[0].ctime, undefined);
  assert.equal(got[0].pax.atime, '1700000001.5');
  assert.equal(got[0].pax.ctime, '1700000002.25');
  assert.equal(got[0].pax.mtime, undefined, 'known mtime is applied to Date, not duplicated');
  equalBytes(got[0].data, data, 'frac data');

  const dumped = JSON.parse(goInspect('dump', tar));
  assert.equal(dumped.length, 1);
  assert.equal(got[0].mtime.getTime(), dumped[0].modTimeUnixMilli);
  assert.equal(dumped[0].modTimeUnixMilli, 1_700_000_000_123);
  assert.equal(dumped[0].pax.atime, '1700000001.5');
  assert.equal(dumped[0].pax.ctime, '1700000002.25');
  assert.equal(dumped[0].accessZero, false);
  assert.equal(dumped[0].changeZero, false);
  assert.equal(dumped[0].accessTimeUnixMilli, 1_700_000_001_500);
  assert.equal(dumped[0].changeTimeUnixMilli, 1_700_000_002_250);
});

test('TarReader matches extract for fractional pax mtime and atime/ctime pax keys', () => {
  const data = Buffer.from('stream');
  const tar = paxTar({
    records: { mtime: '1350244992.023960108', atime: '0', ctime: '123.000000456' },
    fileName: 's.txt',
    fileData: data,
    ustarMtime: 1350244992,
  });
  const whole = tarExtract(tar);
  const chunked = [];
  const reader = new TarReader();
  reader.on('entry', (e) => chunked.push(e));
  for (let i = 0; i < tar.length; i++) reader.write(tar.subarray(i, i + 1));
  reader.end();
  assert.equal(chunked.length, 1);
  assert.equal(chunked[0].mtime.getTime(), whole[0].mtime.getTime());
  assert.equal(chunked[0].pax.atime, whole[0].pax.atime);
  assert.equal(chunked[0].pax.ctime, whole[0].pax.ctime);
  assert.equal(chunked[0].atime, undefined);
  assert.equal(chunked[0].ctime, undefined);

  const dumped = JSON.parse(goInspect('dump', tar));
  assert.equal(whole[0].mtime.getTime(), dumped[0].modTimeUnixMilli);
});

test('Go-written fractional ModTime/AccessTime/ChangeTime extract onto mtime Date + pax atime/ctime', () => {
  const tar = goInspect('write', JSON.stringify([{
    name: 'g.txt',
    typeflag: '0',
    data: 'go-frac',
    modTimeUnix: 1_700_000_000,
    modTimeNsec: 123_456_789,
    accessUnix: 1_700_000_001,
    accessNsec: 500_000_000,
    changeUnix: 1_700_000_002,
    changeNsec: 250_000_000,
  }]));
  const got = tarExtract(tar);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'g.txt');
  assert.equal(got[0].atime, undefined);
  assert.equal(got[0].ctime, undefined);
  const dumped = JSON.parse(goInspect('dump', tar));
  assert.equal(got[0].mtime.getTime(), dumped[0].modTimeUnixMilli);
  assert.equal(got[0].pax.atime, dumped[0].pax.atime);
  assert.equal(got[0].pax.ctime, dumped[0].pax.ctime);
  equalBytes(got[0].data, Buffer.from('go-frac'), 'go-frac data');
});

test('JS Date with millisecond fraction writes pax mtime; Go ModTime UnixMilli matches', () => {
  const data = new Uint8Array([1, 2, 3]);
  const mtime = new Date(1_700_000_000_123);
  const tar = tarCreate([{ name: 'w.txt', data, mtime }]);
  const got = tarExtract(tar);
  assert.equal(got[0].mtime.getTime(), mtime.getTime());
  assert.equal(got[0].atime, undefined);
  assert.equal(got[0].ctime, undefined);

  const dumped = JSON.parse(goInspect('dump', Buffer.from(tar)));
  assert.equal(dumped[0].name, 'w.txt');
  assert.equal(dumped[0].modTimeUnixMilli, mtime.getTime());
  assert.match(dumped[0].pax.mtime, /^1700000000\.1230*$/);
});

test('tarCreate pax atime/ctime stay on entry.pax and are not Date fields', () => {
  const tar = tarCreate([{
    name: 'p.txt',
    data: Buffer.from('p'),
    mtime: new Date(1_700_000_000_000),
    pax: { atime: '1700000001.5', ctime: '1700000002.25' },
  }]);
  const got = tarExtract(tar);
  assert.equal(got[0].mtime.getTime(), 1_700_000_000_000);
  assert.equal(got[0].pax.atime, '1700000001.5');
  assert.equal(got[0].pax.ctime, '1700000002.25');
  assert.equal(got[0].atime, undefined);
  assert.equal(got[0].ctime, undefined);
  const dumped = JSON.parse(goInspect('dump', Buffer.from(tar)));
  assert.equal(dumped[0].pax.atime, '1700000001.5');
  assert.equal(dumped[0].pax.ctime, '1700000002.25');
  assert.equal(got[0].mtime.getTime(), dumped[0].modTimeUnixMilli);
});

test('invalid pax mtime throws TarFormatError like Go ErrHeader', () => {
  const tar = paxTar({
    records: { mtime: 'not-a-time' },
    fileName: 'bad.txt',
    fileData: Buffer.from('x'),
  });
  assert.throws(() => tarExtract(tar), TarFormatError);
  const dumped = spawnSync(
    process.env.RUSTD_GO === 'path' ? 'go' : 'mise',
    process.env.RUSTD_GO === 'path'
      ? ['run', 'main.go', 'dump']
      : ['exec', '--', 'go', 'run', 'main.go', 'dump'],
    {
      cwd: (() => {
        const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp7-bad-'));
        writeFileSync(join(dir, 'main.go'), GO_INSPECT);
        return dir;
      })(),
      input: tar,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert.notEqual(dumped.status, 0);
  assert.match(String(dumped.stderr), /tar/i);
});
