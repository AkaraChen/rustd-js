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

test('Go linux/amd64 with DWARF: dwarf entries, line table, gosym vs debug/gosym', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-dwarf-'));
  const out = join(dir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-X main.version=1.2.3', '.'], {
    cwd: join(pkg, 'gofixtures'),
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);

  const file = open(out);
  assert.equal(file.hasDebugInfo(), true);
  const dwarf = file.dwarf();
  assert.ok(dwarf, 'unstripped Go binary must expose DWARF');
  assert.ok([2, 3, 4, 5].includes(dwarf.version), `dwarf version ${dwarf.version}`);
  assert.equal(typeof dwarf.addressSize, 'number');
  assert.equal(dwarf.byteOrder, 'little');

  let compileUnits = 0;
  let sampled = 0;
  dwarf.iterateEntries((entry) => {
    assert.equal(typeof entry.offset, 'bigint');
    assert.equal(typeof entry.tagValue, 'number');
    assert.ok(entry.tag.startsWith('DW_TAG_') || entry.tag.length > 0);
    for (const attr of entry.attrs) {
      assert.equal(typeof attr.attr, 'string');
      assert.ok(attr.value && typeof attr.value.kind === 'string');
      if (attr.value.kind === 'addr' || attr.value.kind === 'u64' || attr.value.kind === 'ref') {
        assert.equal(typeof attr.value.value, 'bigint');
      }
    }
    if (entry.tag === 'DW_TAG_compile_unit') compileUnits += 1;
    sampled += 1;
    if (sampled >= 200) return false;
  });
  assert.ok(compileUnits >= 1, 'at least one DW_TAG_compile_unit');

  const types = dwarf.types();
  assert.ok(types.some((t) => t.kind === 'struct' && t.name.includes('Box')));

  const gosym = file.gosym();
  assert.ok(gosym, 'Go binary must expose pclntab');
  const mainFn = gosym.lookupFunc('main.main');
  assert.ok(mainFn, 'pclntab lists main.main');
  assert.equal(typeof mainFn.entry, 'bigint');
  assert.equal(typeof mainFn.end, 'bigint');
  assert.ok(mainFn.end > mainFn.entry);
  assert.equal(mainFn.package, 'main');
  assert.equal(mainFn.base, 'main');

  const dump = go(['run', './cmd/dumpgosym', out], { cwd: join(pkg, 'gofixtures') });
  assert.equal(dump.status, 0, dump.stderr + dump.stdout);
  const match = dump.stdout.match(/name=(\S+) entry=(0x[0-9a-f]+) end=(0x[0-9a-f]+) file=(\S+) line=(\d+)/);
  assert.ok(match, dump.stdout);
  assert.equal(mainFn.name, match[1]);
  assert.equal(mainFn.entry, BigInt(match[2]));
  assert.equal(mainFn.end, BigInt(match[3]));

  const atEntry = gosym.pcToLine(mainFn.entry);
  assert.equal(atEntry.file, match[4]);
  assert.equal(atEntry.line, Number(match[5]));
  assert.equal(atEntry.fn?.name, 'main.main');

  const mid = mainFn.entry + (mainFn.end - mainFn.entry) / 2n;
  const atMid = gosym.pcToFunc(mid);
  assert.equal(atMid?.name, 'main.main');

  const lineReader = dwarf.lineReader();
  const files = lineReader.files();
  assert.ok(files.some((f) => f.endsWith('main.go')), files.slice(0, 8));
  const lineFile = lineReader.seekPC(mainFn.entry);
  assert.ok(!lineFile || lineFile.endsWith('main.go'), lineFile);

  const sub = dwarf.seekPC(mainFn.entry);
  if (sub) {
    assert.ok(sub.tag === 'DW_TAG_subprogram' || sub.tag === 'DW_TAG_inlined_subroutine');
    const ranges = dwarf.ranges(sub);
    assert.ok(Array.isArray(ranges));
  }

  file.close();
  const closed = open(out);
  const d2 = closed.dwarf();
  closed.close();
  assert.throws(() => d2.entries(), FileClosedError);
});

test('stripped (-w) Go binary keeps gosym and hides dwarf', () => {
  const path = buildHello();
  const file = open(path);
  assert.equal(file.dwarf(), null);
  const gosym = file.gosym();
  assert.ok(gosym);
  assert.ok(gosym.lookupFunc('main.main'));
  file.close();
});

function parseReadelfDies(text) {
  const dies = [];
  let current = null;
  for (const line of text.split('\n')) {
    const die = line.match(
      /^\s*<\d+><([0-9a-f]+)>:\s+Abbrev Number:\s+(\d+)(?:\s+\(([^)]+)\))?/i,
    );
    if (die) {
      if (current) dies.push(current);
      if (die[2] === '0') {
        current = null;
        continue;
      }
      current = { offset: BigInt(`0x${die[1]}`), tag: die[3] || '', attrs: [] };
      continue;
    }
    const attr = line.match(/^\s*<[0-9a-f]+>\s+(DW_AT_\w+)\s*:\s*(.*)$/i);
    if (attr && current) {
      current.attrs.push({ attr: attr[1], raw: attr[2].trim() });
    }
  }
  if (current) dies.push(current);
  return dies;
}

function extractReadelfString(raw) {
  const labeled = raw.match(/\):\s*(.*)$/);
  if (labeled) return labeled[1];
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (/^<[^>]+>$/.test(raw) || raw.includes('(')) return null;
  if (/^[^\s:]+$/.test(raw) && !raw.startsWith('0x') && Number.isNaN(Number(raw))) return raw;
  return null;
}

function extractReadelfInt(raw) {
  const hex = raw.match(/0x[0-9a-f]+/i);
  if (hex) return BigInt(hex[0]);
  const dec = raw.match(/-?\d+/);
  if (!dec) return null;
  const n = BigInt(dec[0]);
  return n;
}

function attrComparable(ourAttr, raw) {
  const value = ourAttr.value;
  if (value.kind === 'str') {
    const s = extractReadelfString(raw);
    if (s == null) return true;
    return s === value.value || raw.includes(value.value);
  }
  if (value.kind === 'addr' || value.kind === 'u64' || value.kind === 'ref') {
    if (raw.includes('DW_OP_') || raw.includes('length of')) return true;
    const n = extractReadelfInt(raw);
    if (n == null) return true;
    return n === value.value;
  }
  if (value.kind === 'i64') {
    const n = extractReadelfInt(raw);
    if (n == null) return true;
    return n === value.value;
  }
  if (value.kind === 'flag' || value.kind === 'bool') {
    if (/yes|true|\b1\b/i.test(raw)) return value.value === true;
    if (/no|false|\b0\b/i.test(raw)) return value.value === false;
    return true;
  }
  return true;
}

test('sample 100 DIE attrs against readelf --debug-dump=info', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-dwarf-sample-'));
  const out = join(dir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-X main.version=1.2.3', '.'], {
    cwd: join(pkg, 'gofixtures'),
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);

  const dump = spawnSync('readelf', ['--debug-dump=info', out], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });
  assert.equal(dump.status, 0, dump.stderr);
  const oracle = parseReadelfDies(dump.stdout);
  assert.ok(oracle.length >= 100, `readelf DIE count ${oracle.length}`);

  const file = open(out);
  const dwarf = file.dwarf();
  assert.ok(dwarf);
  const byOffset = new Map();
  dwarf.iterateEntries((entry) => {
    byOffset.set(entry.offset, entry);
    if (byOffset.size >= 20000) return false;
  });

  let compared = 0;
  const mismatches = [];
  for (const die of oracle) {
    if (compared >= 100) break;
    const ours = byOffset.get(die.offset);
    if (!ours) {
      mismatches.push(`missing offset 0x${die.offset.toString(16)} tag=${die.tag}`);
      continue;
    }
    if (die.tag && ours.tag !== die.tag) {
      mismatches.push(`offset 0x${die.offset.toString(16)} tag ${ours.tag} != ${die.tag}`);
      compared += 1;
      continue;
    }
    const ourAttrs = new Map(ours.attrs.map((a) => [a.attr, a]));
    for (const attr of die.attrs) {
      const oursAttr = ourAttrs.get(attr.attr);
      if (!oursAttr) {
        mismatches.push(`offset 0x${die.offset.toString(16)} missing ${attr.attr}`);
        continue;
      }
      if (!attrComparable(oursAttr, attr.raw)) {
        const shown = `${oursAttr.value.kind}:${String(oursAttr.value.value)}`;
        mismatches.push(
          `offset 0x${die.offset.toString(16)} ${attr.attr} ours=${shown} readelf=${attr.raw}`,
        );
      }
    }
    compared += 1;
  }
  file.close();
  assert.equal(compared, 100, `compared ${compared} DIEs`);
  assert.equal(mismatches.length, 0, mismatches.slice(0, 12).join('\n'));
});

test('gosym inlineFrames match pclntab inlined tree dump for main.*', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-inline-'));
  const out = join(dir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-X main.version=1.2.3', '.'], {
    cwd: join(pkg, 'gofixtures'),
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);

  const dumped = go(['run', './cmd/dumpinline', out], { cwd: join(pkg, 'gofixtures') });
  assert.equal(dumped.status, 0, dumped.stderr + dumped.stdout);
  const rows = JSON.parse(dumped.stdout);
  assert.ok(Array.isArray(rows) && rows.length > 0, dumped.stdout.slice(0, 200));
  const withInline = rows.filter((r) => r.inlineFrames && r.inlineFrames.length > 0);
  assert.ok(withInline.length > 0, 'fixture must produce at least one inlined PC');
  const inlineNames = [...new Set(withInline.flatMap((r) => r.inlineFrames.map((f) => f.fn)))];
  assert.ok(
    inlineNames.some((n) => n.includes('inlineAdd') || n.includes('inlineMul')),
    `inlined names: ${inlineNames.join(', ')}`,
  );

  const file = open(out);
  const gosym = file.gosym();
  assert.ok(gosym);
  for (const row of rows) {
    const pc = BigInt(row.pc);
    const got = gosym.pcToLine(pc);
    assert.equal(got.fn?.name, row.fn, `fn at ${row.pc}`);
    assert.equal(got.file, row.file, `file at ${row.pc}`);
    assert.equal(got.line, row.line, `line at ${row.pc}`);
    assert.deepEqual(
      got.inlineFrames,
      (row.inlineFrames ?? []).map((f) => ({ file: f.file, line: f.line, fn: f.fn })),
      `inlineFrames at ${row.pc} ${row.name}`,
    );
  }
  file.close();
});

void UnsupportedFeatureError;
void root;
