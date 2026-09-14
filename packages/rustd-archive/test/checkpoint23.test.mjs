import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarCreate, tarExtract } from '../index.mjs';

const GO_SRC = `package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"os"
)

type tarDump struct {
	Name     string \`json:"name"\`
	Typeflag string \`json:"typeflag"\`
	Size     int64  \`json:"size"\`
	Linkname string \`json:"linkname"\`
	DataHex  string \`json:"dataHex"\`
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
			Name:     h.Name,
			Typeflag: string([]byte{h.Typeflag}),
			Size:     h.Size,
			Linkname: h.Linkname,
			DataHex:  fmtHex(data),
		})
	}
	fail(json.NewEncoder(os.Stdout).Encode(out))
}
`;

let inspectDir;

function goCmd() {
  if (process.env.RUSTD_GO === 'path') return { command: 'go', prefix: [] };
  return { command: 'mise', prefix: ['exec', '--', 'go'] };
}

function compileInspect() {
  if (inspectDir) return inspectDir;
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp23-'));
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

function goDump(bytes) {
  const dir = compileInspect();
  const result = spawnSync(join(dir, 'goinspect'), [], {
    input: bytes,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`goinspect exited ${result.status}: ${result.stderr}`);
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
  assert.equal(entry.devmajor, undefined, `${label} no devmajor`);
  assert.equal(entry.devminor, undefined, `${label} no devminor`);
}

function realEntries(list) {
  return list.filter((e) => e.type !== 'x-global-header' && e.type !== 'x-header');
}

function realDump(list) {
  return list.filter((e) => e.typeflag !== 'g' && e.typeflag !== 'x');
}

test('JS tarCreate hardlink/fifo/char/block type+linkname vs Go dump (issue #2 §4.2)', () => {
  const entries = [
    { name: 'target.txt', data: new TextEncoder().encode('payload') },
    { name: 'hl', type: 'hardlink', linkname: 'target.txt' },
    { name: 'pipe', type: 'fifo' },
    { name: 'cdev', type: 'char' },
    { name: 'bdev', type: 'block' },
  ];
  const tar = tarCreate(entries);
  const got = realEntries(tarExtract(tar));
  const dumped = realDump(goDump(tar));
  assert.equal(got.length, dumped.length);
  assert.equal(got.length, 5);

  const expectFlag = { hardlink: '1', fifo: '6', char: '3', block: '4', reg: '0' };
  for (let i = 0; i < got.length; i++) {
    const want = entries[i];
    const type = want.type ?? 'reg';
    const label = `tar ${want.name}`;
    assert.equal(got[i].name, dumped[i].name, `${label} name`);
    assert.equal(got[i].name, want.name, `${label} js name`);
    assert.equal(got[i].type, type, `${label} js type`);
    assert.equal(tarTypeFromFlag(dumped[i].typeflag), type, `${label} Go typeflag ${dumped[i].typeflag}`);
    if (type !== 'reg') {
      assert.equal(dumped[i].typeflag, expectFlag[type], `${label} Go typeflag byte`);
    }
    assert.equal(got[i].linkname ?? '', dumped[i].linkname, `${label} linkname`);
    assert.equal(got[i].linkname ?? '', want.linkname ?? '', `${label} js linkname`);
    assert.equal(got[i].size, dumped[i].size, `${label} size`);
    assert.equal(hexOf(got[i].data), dumped[i].dataHex, `${label} data`);
    if (type !== 'reg') {
      assert.equal(dumped[i].size, 0, `${label} Go size 0`);
      assert.equal(got[i].size, 0, `${label} js size 0`);
    }
    assertNoInvented(got[i], label);
  }
});
