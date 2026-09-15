import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSpawnSync as spawnSync, goExecutable } from '../../../scripts/native-test-tools.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tarCreate, tarExtract, zipCreate, zipExtract,
  TarWriter, ZipWriter,
} from '../index.mjs';

const GO_SRC = `package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
)

type tarDump struct {
	Name             string \`json:"name"\`
	Typeflag         string \`json:"typeflag"\`
	Mode             int64  \`json:"mode"\`
	Uid              int    \`json:"uid"\`
	Gid              int    \`json:"gid"\`
	Uname            string \`json:"uname"\`
	Gname            string \`json:"gname"\`
	Size             int64  \`json:"size"\`
	Linkname         string \`json:"linkname"\`
	ModTimeUnixMilli int64  \`json:"modTimeUnixMilli"\`
	DataHex          string \`json:"dataHex"\`
}

type zipDump struct {
	Name             string \`json:"name"\`
	Method           uint16 \`json:"method"\`
	Comment          string \`json:"comment"\`
	CRC32            uint32 \`json:"crc32"\`
	Size             uint64 \`json:"size"\`
	CompressedSize   uint64 \`json:"compressedSize"\`
	Mode             uint32 \`json:"mode"\`
	NonUTF8          bool   \`json:"nonUtf8"\`
	ModTimeUnixMilli int64  \`json:"modTimeUnixMilli"\`
	DataHex          string \`json:"dataHex"\`
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

func dumpTar() {
	raw, err := io.ReadAll(os.Stdin)
	fail(err)
	r := tar.NewReader(bytes.NewReader(raw))
	out := []tarDump{}
	for {
		h, err := r.Next()
		if err == io.EOF {
			break
		}
		fail(err)
		data, err := io.ReadAll(r)
		fail(err)
		out = append(out, tarDump{
			Name:             h.Name,
			Typeflag:         string([]byte{h.Typeflag}),
			Mode:             h.Mode,
			Uid:              h.Uid,
			Gid:              h.Gid,
			Uname:            h.Uname,
			Gname:            h.Gname,
			Size:             h.Size,
			Linkname:         h.Linkname,
			ModTimeUnixMilli: h.ModTime.UnixMilli(),
			DataHex:          fmtHex(data),
		})
	}
	fail(json.NewEncoder(os.Stdout).Encode(out))
}

func dumpZip() {
	raw, err := io.ReadAll(os.Stdin)
	fail(err)
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	fail(err)
	if zr.Comment != "" {
		os.Stderr.WriteString("archive-level comment present\\n")
		os.Exit(1)
	}
	out := []zipDump{}
	for _, f := range zr.File {
		rc, err := f.Open()
		fail(err)
		data, err := io.ReadAll(rc)
		rc.Close()
		fail(err)
		out = append(out, zipDump{
			Name:             f.Name,
			Method:           f.Method,
			Comment:          f.Comment,
			CRC32:            f.CRC32,
			Size:             f.UncompressedSize64,
			CompressedSize:   f.CompressedSize64,
			Mode:             uint32(f.Mode()),
			NonUTF8:          f.NonUTF8,
			ModTimeUnixMilli: f.Modified.UnixMilli(),
			DataHex:          fmtHex(data),
		})
	}
	fail(json.NewEncoder(os.Stdout).Encode(out))
}

func main() {
	if len(os.Args) < 2 {
		os.Stderr.WriteString("usage: goinspect dump-tar|dump-zip\\n")
		os.Exit(1)
	}
	switch os.Args[1] {
	case "dump-tar":
		dumpTar()
	case "dump-zip":
		dumpZip()
	default:
		os.Stderr.WriteString("usage: goinspect dump-tar|dump-zip\\n")
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
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp22-'));
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

function goDump(kind, bytes) {
  const dir = compileInspect();
  const result = spawnSync(join(dir, goExecutable('goinspect')), [kind === 'tar' ? 'dump-tar' : 'dump-zip'], {
    input: bytes,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`goinspect ${kind} exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function hexOf(u8) {
  return Buffer.from(u8 ?? new Uint8Array()).toString('hex');
}

function tarTypeFromFlag(flag) {
  switch (flag) {
    case '0':
    case '\0':
      return 'reg';
    case '5':
      return 'dir';
    case '2':
      return 'symlink';
    case '1':
      return 'hardlink';
    case '3':
      return 'char';
    case '4':
      return 'block';
    case '6':
      return 'fifo';
    case 'g':
      return 'x-global-header';
    case 'x':
      return 'x-header';
    default:
      return flag;
  }
}

function assertNoInvented(entry, label) {
  assert.equal(entry.atime, undefined, `${label} no atime Date`);
  assert.equal(entry.ctime, undefined, `${label} no ctime Date`);
  assert.equal(entry.extra, undefined, `${label} no extra`);
  assert.equal(entry.archiveComment, undefined, `${label} no archive-level comment`);
}

function modifiedMs(entry) {
  const d = entry.modified ?? entry.mtime;
  return d instanceof Date ? d.getTime() : undefined;
}

test('JS tarCreate field-level mode/uid/gid/uname/gname/mtime vs Go dump (issue #2 §4.2)', () => {
  const mtime = new Date(1_700_000_000_123);
  const entries = [
    {
      name: 'a.txt',
      data: new TextEncoder().encode('alpha'),
      mode: 0o640,
      uid: 1000,
      gid: 1001,
      uname: 'alice',
      gname: 'staff',
      mtime,
    },
    { name: 'dir/', type: 'dir', mode: 0o755, uid: 0, gid: 0, uname: 'root', gname: 'root', mtime },
    { name: 'link', type: 'symlink', linkname: 'a.txt', mode: 0o777, uid: 7, gid: 8, uname: 'lnk', gname: 'grp', mtime },
  ];
  const tar = tarCreate(entries);
  const got = tarExtract(tar).filter((e) => e.type !== 'x-global-header' && e.type !== 'x-header');
  const dumped = goDump('tar', tar).filter((e) => e.typeflag !== 'g' && e.typeflag !== 'x');
  assert.equal(got.length, dumped.length);
  assert.equal(got.length, 3);

  for (let i = 0; i < got.length; i++) {
    const label = `tar ${entries[i].name}`;
    assert.equal(got[i].name, dumped[i].name, `${label} name`);
    assert.equal(got[i].type, tarTypeFromFlag(dumped[i].typeflag), `${label} type`);
    assert.equal(got[i].mode, dumped[i].mode, `${label} mode`);
    assert.equal(got[i].uid ?? 0, dumped[i].uid, `${label} uid`);
    assert.equal(got[i].gid ?? 0, dumped[i].gid, `${label} gid`);
    if (dumped[i].uid === 0) assert.equal(got[i].uid, undefined, `${label} omit zero uid`);
    if (dumped[i].gid === 0) assert.equal(got[i].gid, undefined, `${label} omit zero gid`);
    assert.equal(got[i].uname ?? '', dumped[i].uname, `${label} uname`);
    assert.equal(got[i].gname ?? '', dumped[i].gname, `${label} gname`);
    assert.equal(got[i].linkname ?? '', dumped[i].linkname, `${label} linkname`);
    assert.equal(got[i].size, dumped[i].size, `${label} size`);
    assert.equal(modifiedMs(got[i]), dumped[i].modTimeUnixMilli, `${label} mtime UnixMilli`);
    assert.equal(hexOf(got[i].data), dumped[i].dataHex, `${label} data`);
    assertNoInvented(got[i], label);
  }
});

test('JS zipCreate field-level method/comment/crc32/size/mode/mtime vs Go FileHeader (issue #2 §4.2)', () => {
  const modified = new Date(1_700_000_000_000);
  const entries = [
    {
      name: 's.txt',
      method: 0,
      data: new TextEncoder().encode('store'),
      comment: 'store-cmt',
      mode: 0o644,
      modified,
    },
    {
      name: 'd.txt',
      method: 8,
      data: new TextEncoder().encode('deflate payload'),
      comment: 'deflate-cmt',
      mode: 0o755,
      modified,
    },
    { name: 'folder/', method: 0, data: new Uint8Array(), mode: 0o755, modified },
  ];
  const zip = zipCreate(entries);
  const got = zipExtract(zip);
  const dumped = goDump('zip', zip);
  assert.equal(got.length, dumped.length);
  assert.equal(got.length, 3);

  for (let i = 0; i < got.length; i++) {
    const label = `zip ${entries[i].name}`;
    assert.equal(got[i].name, dumped[i].name, `${label} name`);
    assert.equal(got[i].method, dumped[i].method, `${label} method`);
    assert.equal(got[i].comment ?? '', dumped[i].comment, `${label} comment`);
    if (!dumped[i].comment) assert.equal(got[i].comment, undefined, `${label} omit empty comment`);
    assert.equal(got[i].crc32 >>> 0, dumped[i].crc32 >>> 0, `${label} crc32`);
    assert.equal(got[i].size, dumped[i].size, `${label} size`);
    assert.equal(got[i].compressedSize, dumped[i].compressedSize, `${label} compressedSize`);
    assert.equal(got[i].mode >>> 0, dumped[i].mode >>> 0, `${label} mode`);
    assert.equal(Boolean(got[i].nonUtf8), Boolean(dumped[i].nonUtf8), `${label} nonUtf8`);
    assert.equal(modifiedMs(got[i]), dumped[i].modTimeUnixMilli, `${label} modified UnixMilli`);
    assert.equal(hexOf(got[i].data), dumped[i].dataHex, `${label} data`);
    assertNoInvented(got[i], label);
  }
});

test('TarWriter/ZipWriter.end() field-level matches create() vs Go dump', () => {
  const mtime = new Date(1_712_000_000_500);
  const tarInput = [
    { name: 'w.txt', data: new TextEncoder().encode('writer'), size: 6, mode: 0o640, uid: 9, gid: 10, uname: 'w', gname: 'g', mtime },
  ];
  const tw = new TarWriter();
  tw.writeHeader(tarInput[0]);
  tw.write(tarInput[0].data);
  const fromWriter = tw.end();
  const fromCreate = tarCreate(tarInput);
  const writerDump = goDump('tar', fromWriter).filter((e) => e.typeflag !== 'g' && e.typeflag !== 'x');
  const createDump = goDump('tar', fromCreate).filter((e) => e.typeflag !== 'g' && e.typeflag !== 'x');
  assert.equal(writerDump.length, 1);
  assert.equal(createDump[0].mode, writerDump[0].mode);
  assert.equal(createDump[0].uid, writerDump[0].uid);
  assert.equal(createDump[0].uname, writerDump[0].uname);
  assert.equal(createDump[0].modTimeUnixMilli, writerDump[0].modTimeUnixMilli);
  assert.equal(createDump[0].dataHex, writerDump[0].dataHex);

  const zipInput = [
    { name: 'z.txt', method: 8, data: new TextEncoder().encode('zw'), comment: 'w-cmt', mode: 0o600, modified: mtime },
  ];
  const zw = new ZipWriter();
  zw.writeHeader(zipInput[0]);
  zw.write(zipInput[0].data);
  const zipWriter = zw.end();
  const zipCreateBuf = zipCreate(zipInput);
  const zipWriterDump = goDump('zip', zipWriter);
  const zipCreateDump = goDump('zip', zipCreateBuf);
  assert.equal(zipWriterDump[0].method, 8);
  assert.equal(zipWriterDump[0].comment, zipCreateDump[0].comment);
  assert.equal(zipWriterDump[0].crc32, zipCreateDump[0].crc32);
  assert.equal(zipWriterDump[0].mode, zipCreateDump[0].mode);
  assert.equal(zipWriterDump[0].modTimeUnixMilli, zipCreateDump[0].modTimeUnixMilli);
  assert.equal(zipWriterDump[0].dataHex, zipCreateDump[0].dataHex);
});
