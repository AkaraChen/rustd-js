import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  sniff, open, openBytes, readBuildInfoFile, ElfFile,
  BinaryFormatError, FileClosedError, BlockedRegionError, UnsupportedFeatureError,
} from '../index.mjs';

const pkg = resolve(import.meta.dirname, '..');
const root = resolve(pkg, '../..');

function go(args, opts = {}) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0' },
    ...opts,
  });
  if (result.error) throw result.error;
  return result;
}

function buildHello() {
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-'));
  const out = join(dir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-w -X main.version=1.2.3', '.'], {
    cwd: join(pkg, 'gofixtures'),
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  return out;
}

test('sniff classifies ELF, PE, Mach-O, Plan 9 and rejects short/unknown', () => {
  assert.equal(sniff(Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0)), 'elf');
  assert.equal(sniff(Uint8Array.of(0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0)), 'pe');
  assert.equal(sniff(Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0)), 'macho');
  assert.equal(sniff(Uint8Array.of(0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0)), 'macho');
  assert.equal(sniff(Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2)), 'macho');
  assert.equal(sniff(Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61)), null);
  const plan9 = new Uint8Array(8);
  plan9.set([0, 0, 0x01, 0xeb]);
  assert.equal(sniff(plan9), 'plan9');
  assert.equal(sniff(Uint8Array.of(0, 1, 2, 3)), null);
  assert.equal(sniff(Uint8Array.of(0x7f, 0x45)), null);
});

test('empty and truncated inputs throw BinaryFormatError and do not walk off the buffer', () => {
  assert.throws(() => openBytes(new Uint8Array()), BinaryFormatError);
  assert.throws(() => openBytes(Uint8Array.of(0x7f, 0x45, 0x4c, 0x46)), BinaryFormatError);
  const four = Uint8Array.of(1, 2, 3, 4);
  assert.throws(() => openBytes(four), BinaryFormatError);
});

test('Go linux/amd64 fixture: sections, symbols, buildinfo, ElfFile, close', () => {
  const path = buildHello();
  const bytes = readFileSync(path);
  const file = openBytes(bytes);
  assert.equal(file.kind, 'elf');
  assert.equal(typeof file.size, 'bigint');
  assert.equal(file.size, BigInt(bytes.length));
  assert.equal(file.endian(), 'little');
  assert.equal(file.arch(), 'amd64');
  assert.equal(typeof file.entryPoint(), 'bigint');
  const sections = file.sections();
  assert.ok(sections.some((s) => s.name === '.text'));
  assert.ok(sections.every((s) => typeof s.addr === 'bigint' && typeof s.size === 'bigint'));
  const text = file.section('.text');
  assert.ok(text);
  const data = text.data();
  assert.ok(data.length > 0);
  data[0] = 0;
  assert.notEqual(text.data()[0], undefined);

  const names = new Set(file.symbols().map((s) => s.name));
  assert.ok([...names].some((n) => n.includes('main.main') || n.endsWith('main.main')), [...names].slice(0, 20));
  const mainSym = file.symbols().find((s) => s.name === 'main.main' || s.name.endsWith('main.main'));
  if (mainSym?.go) {
    assert.equal(mainSym.go.base, 'main');
    assert.equal(mainSym.go.package.includes('main'), true);
  }

  const nm = go(['tool', 'nm', path]);
  assert.equal(nm.status, 0, nm.stderr);
  const nmNames = new Set(nm.stdout.split('\n').map((line) => line.trim().split(/\s+/).at(-1)).filter(Boolean));
  assert.ok(nmNames.has('main.main'), 'go tool nm lists main.main');
  assert.ok(names.has('main.main') || [...names].some((n) => n.endsWith('main.main')));

  const info = file.buildInfo();
  assert.ok(info, 'Go binary must expose buildinfo');
  assert.match(info.goVersion, /^go1\./);
  assert.equal(info.path, 'rustd-debugfmt-gofixtures');
  assert.equal(info.main.path, 'rustd-debugfmt-gofixtures');
  const settingKeys = new Set(info.settings.map((s) => s.key));
  assert.ok(settingKeys.has('-ldflags'));
  const fromFile = readBuildInfoFile(path);
  assert.equal(fromFile.goVersion, info.goVersion);

  const version = go(['version', '-m', path]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /go1\./);
  assert.ok(version.stdout.includes(info.goVersion));
  assert.match(version.stdout, /path\trustd-debugfmt-gofixtures/);

  const elf = ElfFile.openBytes(bytes);
  assert.equal(elf.class(), 64);
  assert.equal(elf.machine(), 'amd64');
  assert.ok(['ET_DYN', 'ET_EXEC'].includes(elf.type()));
  elf.close();

  file.close();
  assert.equal(file.closed, true);
  assert.throws(() => file.sections(), FileClosedError);
});

test('maxSectionBytes blocks oversized data() without allocating the claimed size', () => {
  const path = buildHello();
  const file = open(path, { maxSectionBytes: 16 });
  const text = file.section('.text');
  assert.ok(text);
  assert.ok(text.size > 16n);
  assert.throws(() => text.data(), BlockedRegionError);
  file.close();
});

test('truncated copy of a real ELF is a format error', () => {
  const path = buildHello();
  const bytes = readFileSync(path);
  const cut = bytes.subarray(0, 64);
  assert.throws(() => openBytes(cut), BinaryFormatError);
});

test('Java CAFEBABE is not sniffed as Mach-O fat', () => {
  const java = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x3d);
  assert.equal(sniff(java), null);
});

void UnsupportedFeatureError;
void root;
