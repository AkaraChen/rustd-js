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

function parseDecodedLine(text) {
  const rows = [];
  let cuPath = '';
  for (const line of text.split('\n')) {
    const header = line.match(/^(\/.*|<autogenerated>|\.\/.+):(?:\[\+\+\])?$/);
    if (header) {
      cuPath = header[1];
      continue;
    }
    const row = line.match(/^(\S+)\s+(-|\d+)\s+0x([0-9a-f]+)\s*(.*)$/i);
    if (!row) continue;
    const base = row[1];
    const endSequence = row[2] === '-';
    const address = BigInt(`0x${row[3]}`);
    const isStmt = /\bx\b/.test(row[4]);
    let file = base;
    if (cuPath && (cuPath === base || cuPath.endsWith(`/${base}`) || cuPath.endsWith(base))) {
      file = cuPath;
    } else if (cuPath.includes('/')) {
      file = `${cuPath.slice(0, cuPath.lastIndexOf('/') + 1)}${base}`;
    }
    rows.push({
      file,
      line: endSequence ? 0 : Number(row[2]),
      address,
      isStmt,
      endSequence,
    });
  }
  return rows;
}

function coveringLine(rows, pc) {
  let last = null;
  for (const row of rows) {
    if (row.endSequence) {
      if (row.address > pc && last) return last;
      last = null;
      continue;
    }
    if (row.address > pc) return last;
    last = row;
  }
  return last;
}

function lineFromReader(reader, pc) {
  reader.seek(pc);
  let last = null;
  for (;;) {
    const row = reader.next();
    if (!row) break;
    if (row.endSequence) {
      if (row.address > pc && last) return last;
      return last;
    }
    if (row.address > pc) return last;
    last = row;
  }
  return last;
}

test('LineReader vs readelf --debug-dump=decodedline at function entry+mid PCs; next() after EndSequence is null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-line-'));
  const out = join(dir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-X main.version=1.2.3', '.'], {
    cwd: join(pkg, 'gofixtures'),
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);

  const dump = spawnSync('readelf', ['--debug-dump=decodedline', out], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });
  assert.equal(dump.status, 0, dump.stderr);
  const oracle = parseDecodedLine(dump.stdout);
  assert.ok(oracle.length > 0, 'readelf decodedline produced rows');
  assert.ok(oracle.some((r) => r.endSequence), 'readelf decodedline includes EndSequence');

  const file = open(out);
  const gosym = file.gosym();
  assert.ok(gosym);
  const mainFn = gosym.lookupFunc('main.main');
  assert.ok(mainFn);
  const dwarf = file.dwarf();
  assert.ok(dwarf);
  const reader = dwarf.lineReader();

  const mid = mainFn.entry + (mainFn.end - mainFn.entry) / 2n;
  for (const [label, pc] of [['entry', mainFn.entry], ['mid', mid]]) {
    const expected = coveringLine(oracle, pc);
    assert.ok(expected, `readelf has a covering row for ${label} ${pc}`);
    const got = lineFromReader(reader, pc);
    assert.ok(got, `LineReader has a covering row for ${label} ${pc}`);
    assert.equal(got.address, expected.address, `${label} address`);
    assert.equal(got.line, expected.line, `${label} line`);
    assert.equal(got.endSequence, false);
    assert.ok(
      got.file === expected.file || got.file.endsWith('main.go') && expected.file.endsWith('main.go'),
      `${label} file ours=${got.file} readelf=${expected.file}`,
    );
    const seekFile = reader.seekPC(pc);
    assert.ok(seekFile && (seekFile === got.file || seekFile.endsWith('main.go')), `${label} seekPC ${seekFile}`);
  }

  reader.reset();
  let sawEnd = false;
  for (;;) {
    const row = reader.next();
    if (!row) break;
    if (row.endSequence) {
      assert.equal(reader.next(), null, 'next() after EndSequence is null');
      sawEnd = true;
      break;
    }
  }
  assert.equal(sawEnd, true, 'fixture line table includes EndSequence');
  assert.equal(reader.next(), null);

  reader.reset();
  const first = reader.next();
  assert.ok(first);
  file.close();
});

function parseGoNmSize(text) {
  const letter = {
    T: 'text',
    t: 'text',
    D: 'data',
    d: 'data',
    B: 'bss',
    b: 'bss',
    R: 'rodata',
    r: 'rodata',
    U: 'undefined',
    u: 'undefined',
    F: 'file',
    f: 'file',
    _: 'file',
  };
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const [addr, size, code] = parts;
    const name = parts.slice(3).join(' ');
    const kind = letter[code];
    if (!kind) continue;
    rows.push({
      name,
      value: BigInt(`0x${addr}`),
      size: BigInt(size),
      kind,
      code,
    });
  }
  return rows;
}

function tupleKey(row) {
  return JSON.stringify([row.name, row.value.toString(), row.size.toString(), row.kind]);
}

test('symbols() vs go tool nm -size set equality on linux/amd64 (issue #18 §4.2)', () => {
  assert.equal(process.arch, 'x64');
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-nm-'));
  const out = join(dir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-X main.version=1.2.3', '.'], {
    cwd: join(pkg, 'gofixtures'),
    env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);

  const nm = go(['tool', 'nm', '-size', out]);
  assert.equal(nm.status, 0, nm.stderr);
  const nmRows = parseGoNmSize(nm.stdout);
  assert.ok(nmRows.some((r) => r.name === 'main.main'), 'go tool nm lists main.main');

  const file = open(out);
  const ours = file.symbols().map((s) => ({
    name: s.name,
    value: s.value,
    size: s.size,
    kind: s.kind,
  }));
  file.close();

  const nmSet = new Set(nmRows.map(tupleKey));
  const ourSet = new Set(ours.map(tupleKey));
  const onlyNm = [...nmSet].filter((k) => !ourSet.has(k)).slice(0, 12);
  const onlyOurs = [...ourSet].filter((k) => !nmSet.has(k)).slice(0, 12);
  assert.equal(ourSet.size, nmSet.size, `count ours=${ourSet.size} nm=${nmSet.size}`);
  assert.equal(onlyNm.length, 0, `only nm: ${onlyNm.join('\n')}`);
  assert.equal(onlyOurs.length, 0, `only ours: ${onlyOurs.join('\n')}`);

  const objdump = spawnSync('objdump', ['-t', out], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  });
  assert.equal(objdump.status, 0, objdump.stderr);
  const objdumpNames = new Set();
  for (const line of objdump.stdout.split('\n')) {
    const m = line.match(/^[0-9a-f]+\s+\S.*\s(\S+)$/i);
    if (m) objdumpNames.add(m[1]);
  }
  const nmNames = new Set(nmRows.map((r) => r.name));
  const ourNames = new Set(ours.map((r) => r.name));
  const objdumpOnly = [...objdumpNames].filter((n) => !nmNames.has(n) && !ourNames.has(n));
  const nmNotObjdump = [...nmNames].filter((n) => !objdumpNames.has(n));
  // Second source: record disagreements; do not prefer objdump over go tool nm.
  console.log(
    JSON.stringify({
      objdumpVsNm: {
        objdumpNames: objdumpNames.size,
        nmNames: nmNames.size,
        objdumpOnlySample: objdumpOnly.slice(0, 8),
        nmNotObjdumpSample: nmNotObjdump.slice(0, 8),
        objdumpOnlyCount: objdumpOnly.length,
        nmNotObjdumpCount: nmNotObjdump.length,
      },
    }),
  );
});

function nameWithoutInst(name) {
  const start = name.indexOf('[');
  if (start < 0) return name;
  const end = name.lastIndexOf(']');
  if (end < 0) return name;
  return name.slice(0, start) + name.slice(end + 1);
}

/** Oracle: debug/gosym.Sym PackageName/ReceiverName/BaseName (Go 1.20+). */
function parseGoNmName(name, code) {
  const stripped = nameWithoutInst(name);
  let pkg = '';
  if (!(stripped.startsWith('go:') || stripped.startsWith('type:'))) {
    const pathend = stripped.lastIndexOf('/');
    const from = pathend < 0 ? 0 : pathend;
    const i = stripped.indexOf('.', from);
    if (i !== -1) pkg = stripped.slice(0, i);
  }
  let receiver = '';
  {
    const pathend = stripped.lastIndexOf('/');
    const from = pathend < 0 ? 0 : pathend;
    const l = stripped.indexOf('.', from);
    const r = stripped.lastIndexOf('.');
    if (l !== -1 && r !== -1 && l !== r) {
      const rOrig = name.lastIndexOf('.');
      receiver = name.slice(l + 1, rOrig);
    }
  }
  let base = name;
  {
    const iStripped = stripped.lastIndexOf('.');
    if (iStripped !== -1) {
      let i = iStripped;
      if (name !== stripped) {
        const brack = name.indexOf('[');
        if (i > brack) i = name.lastIndexOf('.');
      }
      base = name.slice(i + 1);
    }
  }
  const static_ = typeof code === 'string' && code.length === 1 && code >= 'a';
  return { package: pkg, receiver, base, static: static_ };
}

function parseGoObjdump(text) {
  const funcs = [];
  let current = null;
  for (const line of text.split('\n')) {
    const header = line.match(/^TEXT (.+)\(SB\) (.*)$/);
    if (header) {
      current = { name: header[1], textFile: header[2], entry: null, line: null, lineFile: null };
      funcs.push(current);
      continue;
    }
    if (!current || current.entry != null) continue;
    const inst = line.match(/^\s+(\S+):(\d+)\s+0x([0-9a-f]+)\s/i);
    if (!inst) continue;
    current.lineFile = inst[1];
    current.line = Number(inst[2]);
    current.entry = BigInt(`0x${inst[3]}`);
  }
  return funcs.filter((f) => f.entry != null);
}

function fileMatchesObjdump(got, textFile, lineFile) {
  if (!got) return false;
  if (got === textFile || got === lineFile) return true;
  if (lineFile && (got.endsWith(`/${lineFile}`) || got.endsWith(lineFile))) return true;
  if (textFile === '<autogenerated>') {
    return got === '' || got.includes('autogenerated');
  }
  return false;
}

function canonGoName(name) {
  return name.replaceAll('\u00b7', '.').replace(/\.abiInternal$/, '').replace(/\.abi0$/, '');
}

function objdumpNameMatches(objdumpName, pclntabName) {
  if (objdumpName === pclntabName) return true;
  return canonGoName(objdumpName) === canonGoName(pclntabName);
}

test('gosym pcToFunc/pcToLine vs go tool objdump at each TEXT entry; FuncInfo vs nm name parse (issue #18 §4.4)', () => {
  assert.equal(process.arch, 'x64');
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-gosym-objdump-'));
  const out = join(dir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-X main.version=1.2.3', '.'], {
    cwd: join(pkg, 'gofixtures'),
    env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);

  const dumped = go(['tool', 'objdump', out], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  assert.equal(dumped.status, 0, dumped.stderr);
  const objdumpFuncs = parseGoObjdump(dumped.stdout);
  assert.ok(objdumpFuncs.length > 50, `objdump TEXT count ${objdumpFuncs.length}`);
  assert.ok(objdumpFuncs.some((f) => f.name === 'main.main'), 'objdump lists main.main');
  assert.ok(objdumpFuncs.some((f) => f.name === 'main.(*Box).Name'), 'objdump lists main.(*Box).Name');
  assert.ok(objdumpFuncs.some((f) => f.name === 'runtime.mallocgc'), 'objdump lists runtime.mallocgc');
  assert.ok(objdumpFuncs.some((f) => f.name === 'runtime.(*mheap).alloc'), 'objdump lists runtime.(*mheap).alloc');

  const file = open(out);
  const gosym = file.gosym();
  assert.ok(gosym);

  const mismatches = [];
  let abiSuffix = 0;
  let middleDot = 0;
  for (const fn of objdumpFuncs) {
    const info = gosym.pcToFunc(fn.entry);
    if (!info) {
      mismatches.push(`pcToFunc 0x${fn.entry.toString(16)} objdump=${fn.name} ours=null`);
      continue;
    }
    if (info.name !== fn.name) {
      if (!objdumpNameMatches(fn.name, info.name)) {
        mismatches.push(`pcToFunc 0x${fn.entry.toString(16)} objdump=${fn.name} ours=${info.name}`);
        continue;
      }
      if (fn.name.endsWith('.abi0') || fn.name.endsWith('.abiInternal')) abiSuffix += 1;
      if (info.name.includes('\u00b7') || fn.name.includes('\u00b7')) middleDot += 1;
    }
    const loc = gosym.pcToLine(fn.entry);
    if (!loc.fn || !objdumpNameMatches(fn.name, loc.fn.name)) {
      mismatches.push(`pcToLine.fn 0x${fn.entry.toString(16)} ${fn.name} ours=${loc.fn?.name ?? 'null'}`);
    }
    if (loc.line !== fn.line) {
      mismatches.push(`pcToLine.line ${fn.name} objdump=${fn.line} ours=${loc.line} file=${loc.file}`);
    }
    if (!fileMatchesObjdump(loc.file, fn.textFile, fn.lineFile)) {
      mismatches.push(`pcToLine.file ${fn.name} objdump=${fn.textFile}|${fn.lineFile} ours=${loc.file}`);
    }
  }
  assert.equal(mismatches.length, 0, mismatches.slice(0, 16).join('\n'));
  console.log(JSON.stringify({ objdumpText: objdumpFuncs.length, abiSuffix, middleDot }));

  const nm = go(['tool', 'nm', out]);
  assert.equal(nm.status, 0, nm.stderr);
  const nmText = [];
  for (const line of nm.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [addr, code] = parts;
    const name = parts.slice(2).join(' ');
    if (code !== 'T' && code !== 't') continue;
    nmText.push({ name, code, value: BigInt(`0x${addr}`) });
  }

  const splitMismatches = [];
  let runtimeChecked = 0;
  for (const row of nmText) {
    const exact = gosym.lookupFunc(row.name) ?? gosym.lookupFunc(canonGoName(row.name));
    const info = exact ?? gosym.pcToFunc(row.value);
    if (!info) continue;
    if (canonGoName(info.name) !== canonGoName(row.name)) continue;
    const expected = parseGoNmName(canonGoName(row.name), row.code);
    const fromPclntab = parseGoNmName(info.name, info.static ? 't' : 'T');
    if (info.package !== fromPclntab.package || info.receiver !== fromPclntab.receiver || info.base !== fromPclntab.base) {
      splitMismatches.push(
        `${info.name} FuncInfo!=gosym-split ours=${JSON.stringify({ package: info.package, receiver: info.receiver, base: info.base })} split=${JSON.stringify(fromPclntab)}`,
      );
    }
    const oursCanon = parseGoNmName(canonGoName(info.name), info.static ? 't' : 'T');
    if (oursCanon.package !== expected.package || oursCanon.receiver !== expected.receiver || oursCanon.base !== expected.base) {
      splitMismatches.push(
        `${row.name} canon-split ours=${JSON.stringify(oursCanon)} nm=${JSON.stringify(expected)}`,
      );
    }
    if (info.static !== expected.static) {
      splitMismatches.push(`${row.name} static ours=${info.static} nm=${expected.static} code=${row.code}`);
    }
    if (row.name.startsWith('runtime.')) runtimeChecked += 1;
  }
  assert.ok(runtimeChecked > 10, `runtime.* nm funcs matched ${runtimeChecked}`);
  assert.equal(splitMismatches.length, 0, splitMismatches.slice(0, 16).join('\n'));

  const malloc = gosym.lookupFunc('runtime.mallocgc');
  assert.ok(malloc);
  assert.equal(malloc.package, 'runtime');
  assert.equal(malloc.receiver, '');
  assert.equal(malloc.base, 'mallocgc');
  assert.equal(malloc.static, false);

  const heapAlloc = gosym.lookupFunc('runtime.(*mheap).alloc');
  assert.ok(heapAlloc);
  assert.equal(heapAlloc.package, 'runtime');
  assert.equal(heapAlloc.receiver, '(*mheap)');
  assert.equal(heapAlloc.base, 'alloc');
  assert.equal(heapAlloc.static, false);

  const method = gosym.lookupFunc('main.(*Box).Name');
  assert.ok(method);
  assert.equal(method.package, 'main');
  assert.equal(method.receiver, '(*Box)');
  assert.equal(method.base, 'Name');
  assert.equal(method.static, false);

  const helper = gosym.lookupFunc('main.helper');
  assert.ok(helper);
  assert.equal(helper.package, 'main');
  assert.equal(helper.receiver, '');
  assert.equal(helper.base, 'helper');

  file.close();
});

void UnsupportedFeatureError;
void root;
