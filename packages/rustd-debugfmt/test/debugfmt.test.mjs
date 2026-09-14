import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  sniff, open, openBytes, readBuildInfoFile, ElfFile, PeFile,
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

function elf64leFields(bytes) {
  assert.ok(bytes.length >= 64, 'ELF64 Ehdr');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(bytes[0], 0x7f);
  assert.equal(bytes[4], 2);
  assert.equal(bytes[5], 1);
  return {
    shoff: Number(view.getBigUint64(40, true)),
    shentsize: view.getUint16(58, true),
    shnum: view.getUint16(60, true),
  };
}

function writeElf64LeShdr(buf, at, { name = 0, type = 0, flags = 0n, addr = 0n, offset = 0n, size = 0n, link = 0, info = 0, addralign = 0n, entsize = 0n }) {
  buf.writeUInt32LE(name, at);
  buf.writeUInt32LE(type, at + 4);
  buf.writeBigUInt64LE(flags, at + 8);
  buf.writeBigUInt64LE(addr, at + 16);
  buf.writeBigUInt64LE(offset, at + 24);
  buf.writeBigUInt64LE(size, at + 32);
  buf.writeUInt32LE(link, at + 40);
  buf.writeUInt32LE(info, at + 44);
  buf.writeBigUInt64LE(addralign, at + 48);
  buf.writeBigUInt64LE(entsize, at + 56);
}

/** 1KiB ELF64 LE: NULL + .shstrtab + one SHT_PROGBITS extra section. */
function elf64leTiny({ extraName, extraOffset, extraSize, extraType = 1 }) {
  const shstr = Buffer.from(`\0.shstrtab\0${extraName}\0`);
  const shnum = 3;
  const shoff = 64;
  const shentsize = 64;
  const strOff = shoff + shnum * shentsize;
  const fileLen = 1024;
  assert.ok(strOff + shstr.length <= fileLen);
  const buf = Buffer.alloc(fileLen);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  buf.writeUInt16LE(1, 16); // ET_REL
  buf.writeUInt16LE(62, 18); // EM_X86_64
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(0n, 24);
  buf.writeBigUInt64LE(0n, 32);
  buf.writeBigUInt64LE(BigInt(shoff), 40);
  buf.writeUInt32LE(0, 48);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(0, 54);
  buf.writeUInt16LE(0, 56);
  buf.writeUInt16LE(shentsize, 58);
  buf.writeUInt16LE(shnum, 60);
  buf.writeUInt16LE(1, 62);
  writeElf64LeShdr(buf, shoff, {});
  writeElf64LeShdr(buf, shoff + shentsize, {
    name: 1,
    type: 3,
    offset: BigInt(strOff),
    size: BigInt(shstr.length),
    addralign: 1n,
  });
  writeElf64LeShdr(buf, shoff + 2 * shentsize, {
    name: 11,
    type: extraType,
    offset: extraOffset,
    size: extraSize,
    addralign: 1n,
  });
  shstr.copy(buf, strOff);
  return { bytes: new Uint8Array(buf), shoff, shentsize, shnum, fileLen };
}

test('issue #18 §4.7: truncate at each ELF section header → BinaryFormatError, no OOB', () => {
  const path = buildHello();
  const full = readFileSync(path);
  const { shoff, shentsize, shnum } = elf64leFields(full);
  assert.equal(shentsize, 64);
  assert.ok(shnum >= 2, `shnum=${shnum}`);
  assert.ok(shoff + shnum * shentsize <= full.length);

  let cuts = 0;
  for (let i = 0; i < shnum; i += 1) {
    const at = shoff + i * shentsize;
    const cut = full.subarray(0, at);
    assert.throws(
      () => openBytes(cut),
      (err) => {
        assert.ok(err instanceof BinaryFormatError, String(err));
        assert.equal(err.kind, 'truncated', `header ${i} kind=${err.kind} offset=${err.offset}`);
        assert.equal(err.offset, BigInt(at), `header ${i} offset ${err.offset} != ${at}`);
        return true;
      },
    );
    cuts += 1;
  }
  assert.equal(cuts, shnum);

  const tiny = elf64leTiny({ extraName: '.ok', extraOffset: 0n, extraSize: 16n });
  for (let i = 0; i < tiny.shnum; i += 1) {
    const at = tiny.shoff + i * tiny.shentsize;
    assert.throws(
      () => openBytes(tiny.bytes.subarray(0, at)),
      (err) => {
        assert.ok(err instanceof BinaryFormatError, String(err));
        assert.equal(err.kind, 'truncated');
        assert.equal(err.offset, BigInt(at));
        return true;
      },
    );
  }
});

test('issue #18 §4.7: sh_offset+sh_size past EOF is BinaryFormatError; 4GiB sh_size is BlockedRegionError', () => {
  const overflow = elf64leTiny({
    extraName: '.overflow',
    extraOffset: BigInt(1024 - 8),
    extraSize: 32n,
  });
  const overflowFile = openBytes(overflow.bytes);
  const overflowSec = overflowFile.section('.overflow');
  assert.ok(overflowSec);
  assert.equal(overflowSec.size, 32n);
  assert.throws(
    () => overflowSec.data(),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'truncated');
      return true;
    },
  );
  overflowFile.close();

  const bomb = elf64leTiny({
    extraName: '.bomb',
    extraOffset: 0n,
    extraSize: 0x1_0000_0000n,
  });
  assert.equal(bomb.bytes.length, 1024);
  const rssBefore = process.memoryUsage().rss;
  const bombFile = openBytes(bomb.bytes);
  const bombSec = bombFile.section('.bomb');
  assert.ok(bombSec);
  assert.equal(bombSec.size, 0x1_0000_0000n);
  assert.throws(() => bombSec.data(), BlockedRegionError);
  const rssAfter = process.memoryUsage().rss;
  assert.ok(
    rssAfter - rssBefore < 64 * 1024 * 1024,
    `rss grew ${rssAfter - rssBefore} after 4GiB sh_size data()`,
  );
  bombFile.close();
});

test('Java CAFEBABE is not sniffed as Mach-O fat', () => {
  const java = Uint8Array.of(0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x3d);
  assert.equal(sniff(java), null);
});

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function nativeFatCpu() {
  if (process.arch === 'arm64') return CPU_TYPE_ARM64;
  if (process.arch === 'x64' || process.arch === 'x86_64') return CPU_TYPE_X86_64;
  throw new Error(`unsupported test arch ${process.arch}`);
}

function foreignFatCpu() {
  return nativeFatCpu() === CPU_TYPE_X86_64 ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64;
}

function fat32({ nfatArch = 1, arches, extra = 0 }) {
  const entries = arches ?? [];
  const buf = Buffer.alloc(8 + nfatArch * 20 + extra);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt32BE(nfatArch, 4);
  for (let i = 0; i < entries.length; i += 1) {
    const at = 8 + i * 20;
    buf.writeUInt32BE(entries[i].cputype, at);
    buf.writeUInt32BE(entries[i].cpusubtype ?? 0, at + 4);
    buf.writeUInt32BE(entries[i].offset, at + 8);
    buf.writeUInt32BE(entries[i].size, at + 12);
    buf.writeUInt32BE(entries[i].align ?? 0, at + 16);
  }
  return new Uint8Array(buf);
}

function fat64({ nfatArch = 1, arches, extra = 0 }) {
  const entries = arches ?? [];
  const buf = Buffer.alloc(8 + nfatArch * 32 + extra);
  buf.writeUInt32BE(0xcafebabf, 0);
  buf.writeUInt32BE(nfatArch, 4);
  for (let i = 0; i < entries.length; i += 1) {
    const at = 8 + i * 32;
    buf.writeUInt32BE(entries[i].cputype, at);
    buf.writeUInt32BE(entries[i].cpusubtype ?? 0, at + 4);
    buf.writeBigUInt64BE(BigInt(entries[i].offset), at + 8);
    buf.writeBigUInt64BE(BigInt(entries[i].size), at + 16);
    buf.writeUInt32BE(entries[i].align ?? 0, at + 24);
    buf.writeUInt32BE(0, at + 28);
  }
  return new Uint8Array(buf);
}

test('issue #18 §4.7: Mach-O fat missing native arch is UnsupportedFeatureError', () => {
  const bytes = fat32({
    nfatArch: 1,
    extra: 16,
    arches: [{ cputype: foreignFatCpu(), offset: 28, size: 16 }],
  });
  assert.equal(sniff(bytes.subarray(0, 8)), 'macho');
  assert.throws(
    () => openBytes(bytes),
    (err) => {
      assert.ok(err instanceof UnsupportedFeatureError, String(err));
      assert.match(String(err.message), /no slice for this process architecture/);
      return true;
    },
  );
});

test('issue #18 §4.7: Mach-O fat header offset OOB is BinaryFormatError', () => {
  const oobOffset = 4096;
  const fat = fat32({
    nfatArch: 1,
    arches: [{ cputype: nativeFatCpu(), offset: oobOffset, size: 16 }],
  });
  assert.equal(fat.length, 28);
  assert.throws(
    () => openBytes(fat),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'truncated');
      assert.equal(err.offset, BigInt(oobOffset));
      return true;
    },
  );

  const pastEof = fat32({
    nfatArch: 1,
    extra: 8,
    arches: [{ cputype: nativeFatCpu(), offset: 28, size: 32 }],
  });
  assert.equal(pastEof.length, 36);
  assert.throws(
    () => openBytes(pastEof),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'truncated');
      assert.equal(err.offset, 28n);
      return true;
    },
  );

  const tableCut = fat32({ nfatArch: 2, arches: [{ cputype: nativeFatCpu(), offset: 48, size: 4 }] });
  assert.equal(tableCut.length, 8 + 40);
  const truncatedTable = tableCut.subarray(0, 8 + 20);
  assert.throws(
    () => openBytes(truncatedTable),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'truncated');
      assert.equal(err.offset, 28n);
      return true;
    },
  );

  const fat64oob = fat64({
    nfatArch: 1,
    arches: [{ cputype: nativeFatCpu(), offset: 0x1_0000_0000, size: 16 }],
  });
  assert.throws(
    () => openBytes(fat64oob),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'truncated');
      assert.equal(err.offset, 0x1_0000_0000n);
      return true;
    },
  );
});

/** Minimal PE32+ image: MZ + PE\0\0 + one .text section. */
function pe64({
  numberOfSections = 1,
  sizeOfImage = 0x2000,
  virtualAddress = 0x1000,
  virtualSize = 0x200,
  sizeOfRawData = 0x200,
} = {}) {
  const eLfanew = 0x80;
  const coff = eLfanew + 4;
  const optSize = 0xf0;
  const opt = coff + 20;
  const sectionsOff = opt + optSize;
  const fileAlign = 0x200;
  const headersEnd = sectionsOff + Math.max(numberOfSections, 0) * 40;
  const sizeOfHeaders = Math.ceil(Math.max(headersEnd, fileAlign) / fileAlign) * fileAlign;
  const buf = Buffer.alloc(sizeOfHeaders + sizeOfRawData);
  buf.write('MZ', 0);
  buf.writeUInt32LE(eLfanew, 0x3c);
  buf.write('PE\0\0', eLfanew);
  buf.writeUInt16LE(0x8664, coff);
  buf.writeUInt16LE(numberOfSections, coff + 2);
  buf.writeUInt16LE(optSize, coff + 16);
  buf.writeUInt16LE(0x0002, coff + 18);
  buf.writeUInt16LE(0x20b, opt);
  buf.writeUInt32LE(virtualAddress, opt + 16);
  buf.writeUInt32LE(virtualAddress, opt + 20);
  buf.writeBigUInt64LE(0x140000000n, opt + 24);
  buf.writeUInt32LE(0x1000, opt + 32);
  buf.writeUInt32LE(fileAlign, opt + 36);
  buf.writeUInt16LE(4, opt + 40);
  buf.writeUInt16LE(4, opt + 48);
  buf.writeUInt32LE(sizeOfImage, opt + 56);
  buf.writeUInt32LE(sizeOfHeaders, opt + 60);
  buf.writeUInt16LE(3, opt + 68);
  buf.writeUInt32LE(16, opt + 108);
  if (numberOfSections >= 1) {
    buf.write('.text\0\0\0', sectionsOff);
    buf.writeUInt32LE(virtualSize, sectionsOff + 8);
    buf.writeUInt32LE(virtualAddress, sectionsOff + 12);
    buf.writeUInt32LE(sizeOfRawData, sectionsOff + 16);
    buf.writeUInt32LE(sizeOfHeaders, sectionsOff + 20);
    buf.writeUInt32LE(0x60000020, sectionsOff + 36);
  }
  return {
    bytes: new Uint8Array(buf),
    numberOfSectionsOffset: coff + 2,
    sizeOfImageOffset: opt + 56,
  };
}

test('issue #18 §4.7: PE NumberOfSections=0 is BinaryFormatError', () => {
  const pe = pe64({ numberOfSections: 0, sizeOfImage: 0x200 });
  assert.equal(sniff(pe.bytes.subarray(0, 8)), 'pe');
  assert.throws(
    () => openBytes(pe.bytes),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'sections');
      assert.equal(err.offset, BigInt(pe.numberOfSectionsOffset));
      return true;
    },
  );
});

test('issue #18 §4.7: PE SizeOfImage vs actual sections is BinaryFormatError', () => {
  const tooSmall = pe64({ numberOfSections: 1, sizeOfImage: 0x1000, virtualAddress: 0x1000, virtualSize: 0x200 });
  assert.throws(
    () => openBytes(tooSmall.bytes),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'size_of_image');
      assert.equal(err.offset, BigInt(tooSmall.sizeOfImageOffset));
      return true;
    },
  );

  const unaligned = pe64({ numberOfSections: 1, sizeOfImage: 0x2001, virtualAddress: 0x1000, virtualSize: 0x200 });
  assert.throws(
    () => openBytes(unaligned.bytes),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'size_of_image');
      assert.equal(err.offset, BigInt(unaligned.sizeOfImageOffset));
      return true;
    },
  );

  const ok = pe64({ numberOfSections: 1, sizeOfImage: 0x2000, virtualAddress: 0x1000, virtualSize: 0x200 });
  const file = openBytes(ok.bytes);
  assert.equal(file.kind, 'pe');
  const pe = PeFile.openBytes(ok.bytes);
  assert.equal(pe.coffHeader().numberOfSections, 1);
  pe.close();
  file.close();
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

test('LineReader vs readelf --debug-dump=decodedline at function entry+mid PCs; next() after EndSequence continues', () => {
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
  let afterEnd = null;
  for (;;) {
    const row = reader.next();
    if (!row) break;
    if (row.endSequence) {
      afterEnd = reader.next();
      sawEnd = true;
      break;
    }
  }
  assert.equal(sawEnd, true, 'fixture line table includes EndSequence');
  assert.ok(afterEnd, 'next() after EndSequence continues to the next sequence');
  assert.equal(typeof afterEnd.address, 'bigint');

  reader.reset();
  const first = reader.next();
  assert.ok(first);
  let n = 1;
  while (reader.next()) n += 1;
  assert.ok(n > 2, `concatenated line table has ${n} rows`);
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

function git(args, opts = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'rustd-debugfmt', GIT_AUTHOR_EMAIL: 'fixture@rustd-js.test', GIT_COMMITTER_NAME: 'rustd-debugfmt', GIT_COMMITTER_EMAIL: 'fixture@rustd-js.test' },
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
  }
  return result;
}

function parseGoQuoted(raw) {
  if (!raw) return '';
  if (raw[0] !== '"' && raw[0] !== '`') return raw;
  return JSON.parse(raw.includes('\\') || raw.startsWith('"') ? raw : JSON.stringify(raw.slice(1, -1)));
}

function parseBuildSetting(kv) {
  let key;
  let rest;
  if (kv[0] === '"' || kv[0] === '`') {
    const end = kv.indexOf(kv[0], 1);
    assert.ok(end > 0 && kv[end + 1] === '=', `quoted build key: ${kv}`);
    key = parseGoQuoted(kv.slice(0, end + 1));
    rest = kv.slice(end + 2);
  } else {
    const eq = kv.indexOf('=');
    assert.ok(eq > 0, `build line missing '=': ${kv}`);
    key = kv.slice(0, eq);
    rest = kv.slice(eq + 1);
  }
  const value = rest.startsWith('"') || rest.startsWith('`') ? parseGoQuoted(rest) : rest;
  return { key, value };
}

function parseModuleCols(cols) {
  return { path: cols[0] ?? '', version: cols[1] ?? '', sum: cols[2] ?? '' };
}

function parseGoVersionM(stdout) {
  const lines = stdout.split('\n');
  const header = lines[0] ?? '';
  const colon = header.lastIndexOf(': ');
  assert.ok(colon > 0, `go version -m header: ${header}`);
  const info = {
    goVersion: header.slice(colon + 2),
    path: '',
    main: { path: '', version: '', sum: '' },
    deps: [],
    settings: [],
  };
  let last = null;
  for (const raw of lines.slice(1)) {
    if (!raw) continue;
    const line = raw.startsWith('\t') ? raw.slice(1) : raw;
    if (!line) continue;
    if (line.startsWith('path\t')) {
      info.path = line.slice(5);
    } else if (line.startsWith('mod\t')) {
      info.main = parseModuleCols(line.slice(4).split('\t'));
      last = info.main;
    } else if (line.startsWith('dep\t')) {
      const dep = parseModuleCols(line.slice(4).split('\t'));
      info.deps.push(dep);
      last = dep;
    } else if (line.startsWith('=>\t')) {
      assert.ok(last, `replacement with no module: ${line}`);
      last.replace = parseModuleCols(line.slice(3).split('\t'));
      last = null;
    } else if (line.startsWith('build\t')) {
      info.settings.push(parseBuildSetting(line.slice(6)));
    }
  }
  return info;
}

function quoteBuildKey(key) {
  return key.length === 0 || /[= \t\r\n"`]/.test(key);
}

function quoteBuildValue(value) {
  return /[ \t\r\n"`]/.test(value);
}

function formatModuleLines(word, m) {
  if (m.replace) {
    return [`${word}\t${m.path}\t${m.version}`, ...formatModuleLines('=>', m.replace), ''];
  }
  return [`${word}\t${m.path}\t${m.version}\t${m.sum ?? ''}`];
}

function formatBuildInfoBody(info) {
  const lines = [];
  if (info.path) lines.push(`path\t${info.path}`);
  if (info.main?.path || info.main?.version) lines.push(...formatModuleLines('mod', info.main));
  for (const dep of info.deps ?? []) lines.push(...formatModuleLines('dep', dep));
  for (const s of info.settings ?? []) {
    const key = quoteBuildKey(s.key) ? JSON.stringify(s.key) : s.key;
    const value = quoteBuildValue(s.value) ? JSON.stringify(s.value) : s.value;
    lines.push(`build\t${key}=${value}`);
  }
  return lines;
}

function buildVcsHello() {
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-buildinfo-'));
  mkdirSync(join(dir, 'leaf'));
  writeFileSync(join(dir, 'go.mod'), `module rustd-debugfmt-gofixtures

go 1.24

require example.com/leaf v0.0.0
replace example.com/leaf => ./leaf
`);
  writeFileSync(join(dir, 'leaf/go.mod'), 'module example.com/leaf\n\ngo 1.24\n');
  writeFileSync(join(dir, 'leaf/leaf.go'), 'package leaf\n\nfunc Version() string { return "leaf" }\n');
  writeFileSync(join(dir, 'main.go'), `package main

import (
	"fmt"
	"example.com/leaf"
)

var version = "dev"

type Box struct {
	Label string
}

//go:noinline
func (b *Box) Name() string { return b.Label }

func helper(n int) int {
	if n < 2 {
		return n
	}
	return helper(n-1) + helper(n-2)
}

//go:noinline
func opaque() int { return 3 }

func inlineAdd(a, b int) int { return a + b }

func inlineMul(a, b int) int { return inlineAdd(a, 1) + a*b }

func main() {
	box := &Box{Label: version}
	x := opaque()
	fmt.Println(box.Name(), helper(8), inlineMul(x, x+1), leaf.Version())
}
`);
  git(['init', '-q'], { cwd: dir });
  git(['add', '.'], { cwd: dir });
  git(['commit', '-qm', 'fixture'], { cwd: dir });
  const revision = git(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
  const out = join(dir, 'hello');
  const built = go(['build', '-buildvcs=true', '-o', out, '-ldflags', '-X main.version=1.2.3', '.'], {
    cwd: dir,
    env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  return { dir, out, revision };
}

test('buildInfo() vs go version -m line equality for goVersion/path/main/deps/settings (issue #18 §4.5)', () => {
  assert.equal(process.arch, 'x64');
  const { out, revision } = buildVcsHello();
  const version = go(['version', '-m', out]);
  assert.equal(version.status, 0, version.stderr);
  const expected = parseGoVersionM(version.stdout);

  const file = open(out);
  const info = file.buildInfo();
  file.close();
  assert.ok(info, 'Go binary must expose buildinfo');

  assert.equal(info.goVersion, expected.goVersion);
  assert.equal(info.path, expected.path);
  assert.deepEqual(info.main, expected.main);
  assert.deepEqual(info.deps, expected.deps);
  assert.deepEqual(info.settings, expected.settings);

  const header = (version.stdout.split('\n')[0] ?? '');
  assert.equal(header.slice(header.lastIndexOf(': ') + 2), info.goVersion);
  const gotBody = formatBuildInfoBody(info);
  const wantBody = version.stdout
    .split('\n')
    .slice(1)
    .filter((raw) => raw.length > 0)
    .map((raw) => (raw.startsWith('\t') ? raw.slice(1) : raw));
  while (wantBody.length && wantBody[wantBody.length - 1] === '') wantBody.pop();
  while (gotBody.length && gotBody[gotBody.length - 1] === '') gotBody.pop();
  assert.deepEqual(gotBody, wantBody);

  const byKey = Object.fromEntries(info.settings.map((s) => [s.key, s.value]));
  assert.equal(byKey['vcs.revision'], revision);
  assert.match(byKey['-ldflags'] ?? '', /main\.version=1\.2\.3/);
  assert.equal(info.deps.length, 1);
  assert.equal(info.deps[0].path, 'example.com/leaf');
  assert.equal(info.deps[0].replace?.path, './leaf');

  const fromFile = readBuildInfoFile(out);
  assert.deepEqual(fromFile, info);
});

test('symbols() JSON dump is read back by Go fixture vs go tool nm -size and debug/elf (issue #18 §4.6)', () => {
  assert.equal(process.arch, 'x64');
  const dir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-reverse-syms-'));
  const out = join(dir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-X main.version=1.2.3', '.'], {
    cwd: join(pkg, 'gofixtures'),
    env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' },
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);

  const file = open(out);
  const dump = file.symbols().map((s) => ({
    name: s.name,
    value: s.value.toString(),
    size: s.size.toString(),
    kind: s.kind,
  }));
  file.close();
  assert.ok(dump.some((s) => s.name === 'main.main'));
  const dumpPath = join(dir, 'symbols.json');
  writeFileSync(dumpPath, JSON.stringify(dump));

  const verified = go(['run', './cmd/readsymbols', out, dumpPath], {
    cwd: join(pkg, 'gofixtures'),
  });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.match(verified.stdout, /^ok dump=\d+ nm=\d+ elfMatched=\d+ main\.main=1\n$/);
  const counts = verified.stdout.match(/dump=(\d+) nm=(\d+) elfMatched=(\d+)/);
  assert.ok(counts);
  assert.equal(counts[1], counts[2]);
  assert.ok(Number(counts[1]) === dump.length);
  assert.ok(Number(counts[3]) > 0);
});

function uleb(n) {
  const out = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function elf64leNamedSections(parts) {
  const names = ['.shstrtab', ...parts.map((p) => p.name)];
  const nameOff = { '': 0 };
  const chunks = [Buffer.from([0])];
  let cursor = 1;
  for (const n of names) {
    nameOff[n] = cursor;
    chunks.push(Buffer.from(`${n}\0`));
    cursor += n.length + 1;
  }
  const shstr = Buffer.concat(chunks);
  const shnum = 2 + parts.length;
  const ehdr = 64;
  const shentsize = 64;
  const shoff = ehdr;
  const shstrOff = shoff + shnum * shentsize;
  const payloads = [];
  let dataOff = shstrOff + shstr.length;
  for (const part of parts) {
    payloads.push({ ...part, offset: dataOff });
    dataOff += part.data.length;
  }
  const buf = Buffer.alloc(dataOff);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  buf.writeUInt16LE(1, 16);
  buf.writeUInt16LE(62, 18);
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(0n, 24);
  buf.writeBigUInt64LE(0n, 32);
  buf.writeBigUInt64LE(BigInt(shoff), 40);
  buf.writeUInt32LE(0, 48);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(0, 54);
  buf.writeUInt16LE(0, 56);
  buf.writeUInt16LE(shentsize, 58);
  buf.writeUInt16LE(shnum, 60);
  buf.writeUInt16LE(1, 62);
  writeElf64LeShdr(buf, shoff, {});
  writeElf64LeShdr(buf, shoff + shentsize, {
    name: nameOff['.shstrtab'],
    type: 3,
    offset: BigInt(shstrOff),
    size: BigInt(shstr.length),
    addralign: 1n,
  });
  payloads.forEach((part, i) => {
    writeElf64LeShdr(buf, shoff + (2 + i) * shentsize, {
      name: nameOff[part.name],
      type: 1,
      offset: BigInt(part.offset),
      size: BigInt(part.data.length),
      addralign: 1n,
    });
    part.data.copy(buf, part.offset);
  });
  shstr.copy(buf, shstrOff);
  return new Uint8Array(buf);
}

function dwarfLineTwoSequences() {
  const stdLengths = Buffer.from([0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1]);
  const files = Buffer.concat([Buffer.from('t.c\0'), uleb(0), uleb(0), uleb(0), Buffer.from([0])]);
  const headerBody = Buffer.concat([
    Buffer.from([1, 1, 1, 0, 1, 13]),
    stdLengths,
    Buffer.from([0]),
    files,
  ]);
  const setAddr = (addr) => {
    const b = Buffer.alloc(11);
    b[0] = 0;
    b[1] = 9;
    b[2] = 2;
    b.writeBigUInt64LE(addr, 3);
    return b;
  };
  const endSeq = Buffer.from([0, 1, 1]);
  const program = Buffer.concat([
    setAddr(0x1000n),
    Buffer.from([1]),
    endSeq,
    setAddr(0x2000n),
    Buffer.from([1]),
    endSeq,
  ]);
  const headerLength = headerBody.length;
  const unitLength = 2 + 4 + headerLength + program.length;
  const out = Buffer.alloc(4 + unitLength);
  out.writeUInt32LE(unitLength, 0);
  out.writeUInt16LE(4, 4);
  out.writeUInt32LE(headerLength, 6);
  headerBody.copy(out, 10);
  program.copy(out, 10 + headerLength);
  return out;
}

function dwarfSpecCycleAndLine() {
  const abbrev = Buffer.from([
    1, 0x11, 1, 0x10, 0x17, 0, 0,
    2, 0x13, 0, 0x03, 0x08, 0x47, 0x13, 0, 0,
    0,
  ]);
  const infoBody = Buffer.alloc(27);
  infoBody.writeUInt16LE(4, 0);
  infoBody.writeUInt32LE(0, 2);
  infoBody[6] = 8;
  infoBody[7] = 1;
  infoBody.writeUInt32LE(0, 8);
  infoBody[12] = 2;
  infoBody[13] = 0x41;
  infoBody[14] = 0;
  infoBody.writeUInt32LE(23, 15);
  infoBody[19] = 2;
  infoBody[20] = 0x42;
  infoBody[21] = 0;
  infoBody.writeUInt32LE(16, 22);
  infoBody[26] = 0;
  const info = Buffer.alloc(4 + infoBody.length);
  info.writeUInt32LE(infoBody.length, 0);
  infoBody.copy(info, 4);
  const line = dwarfLineTwoSequences();
  return {
    bytes: elf64leNamedSections([
      { name: '.debug_abbrev', data: abbrev },
      { name: '.debug_info', data: info },
      { name: '.debug_line', data: line },
    ]),
    dieA: 16n,
    dieB: 23n,
  };
}

test('issue #18 §4.7: DW_AT_specification cycle is BinaryFormatError with a depth cap', () => {
  const { bytes, dieA, dieB } = dwarfSpecCycleAndLine();
  const file = openBytes(bytes);
  const dwarf = file.dwarf();
  assert.ok(dwarf);
  const entries = dwarf.entries();
  assert.equal(entries.length, 3);
  const a = dwarf.entryAt(dieA);
  const b = dwarf.entryAt(dieB);
  assert.ok(a);
  assert.ok(b);
  assert.equal(a.tag, 'DW_TAG_structure_type');
  assert.equal(b.tag, 'DW_TAG_structure_type');
  const specA = a.attrs.find((x) => x.attr === 'DW_AT_specification');
  const specB = b.attrs.find((x) => x.attr === 'DW_AT_specification');
  assert.equal(specA?.value.kind, 'ref');
  assert.equal(specA.value.value, dieB);
  assert.equal(specB.value.value, dieA);

  const t0 = process.hrtime.bigint();
  assert.throws(
    () => a.type(),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'dwarf_cycle');
      return true;
    },
  );
  assert.throws(
    () => b.type(),
    (err) => {
      assert.ok(err instanceof BinaryFormatError, String(err));
      assert.equal(err.kind, 'dwarf_cycle');
      return true;
    },
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `cycle follow took ${ms}ms`);
  const listed = dwarf.types().filter((t) => t.kind === 'struct');
  assert.equal(listed.length, 2);
  file.close();
});

test('issue #18 §4.7: LineReader next() after EndSequence yields the next sequence', () => {
  const { bytes } = dwarfSpecCycleAndLine();
  const file = openBytes(bytes);
  const dwarf = file.dwarf();
  assert.ok(dwarf);
  const reader = dwarf.lineReader();
  const first = reader.next();
  assert.ok(first);
  assert.equal(first.address, 0x1000n);
  assert.equal(first.endSequence, false);
  const end1 = reader.next();
  assert.ok(end1);
  assert.equal(end1.endSequence, true);
  assert.equal(end1.address, 0x1000n);
  const second = reader.next();
  assert.ok(second, 'Next after EndSequence must continue');
  assert.equal(second.endSequence, false);
  assert.equal(second.address, 0x2000n);
  const end2 = reader.next();
  assert.ok(end2);
  assert.equal(end2.endSequence, true);
  assert.equal(reader.next(), null);
  file.close();
});

void UnsupportedFeatureError;
void root;
