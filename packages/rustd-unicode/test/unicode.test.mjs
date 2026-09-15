import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  unicodeVersion,
  isControl,
  isDigit,
  isGraphic,
  isLetter,
  isLower,
  isMark,
  isNumber,
  isPrint,
  isPunct,
  isSpace,
  isSymbol,
  isTitle,
  isUpper,
  isTable,
  isOneOfTables,
  tablesOf,
  rangeTableNames,
  toUpper,
  toLower,
  toTitle,
  simpleFold,
  toSpecialCase,
  utf8Valid,
  utf8ValidString,
  utf8ValidRune,
  utf8RuneLen,
  utf8RuneCount,
  utf8RuneStart,
  utf8FullRune,
  utf8DecodeRune,
  utf8DecodeLastRune,
  utf8EncodeRune,
  utf8EncodeRuneStrict,
  utf8AppendRune,
  utf8Runes,
  utf8RuneError,
  utf16Encode,
  utf16EncodeRune,
  utf16Decode,
  utf16DecodeRune,
  utf16IsSurrogate,
  utf16RuneLen,
  firstIsTableMismatch,
  firstCaseMismatch,
  caseFullChecksum,
  UnknownTableError,
  InvalidRuneError,
} from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const go = JSON.parse(readFileSync(join(dir, 'fixtures/go.json'), 'utf8'));
const tableRuns = JSON.parse(readFileSync(join(dir, 'fixtures/tables.json'), 'utf8')).tables;

const predicates = {
  isControl, isDigit, isGraphic, isLetter, isLower, isMark, isNumber,
  isPrint, isPunct, isSpace, isSymbol, isTitle, isUpper,
};

function inRuns(runs, r) {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    const [a, b] = runs[m];
    if (r < a) hi = m;
    else if (r > b) lo = m + 1;
    else return true;
  }
  return false;
}

test('unicode version matches Go 15.0.0', () => {
  assert.equal(unicodeVersion, '15.0.0');
  assert.equal(go.version, '15.0.0');
  assert.equal(go.goVersion, 'go1.24.13');
});

test('range table names equal Go exported *RangeTable set', () => {
  const names = rangeTableNames();
  assert.deepEqual(names, go.tableNames);
  assert.equal(names.length, go.tableCount);
  assert.equal(names.length, 245);
});

test('unknown table name throws instead of returning false', () => {
  assert.throws(() => isTable('latin', 0x41), UnknownTableError);
  assert.throws(() => isOneOfTables(['Latin', 'nope'], 0x41), UnknownTableError);
});

test('13 boolean predicates match Go change-point runs (endpoints + interior stride)', () => {
  for (const [name, fn] of Object.entries(predicates)) {
    const runs = go.predicates[name];
    for (const [lo, hi] of runs) {
      assert.equal(fn(lo), true, `${name}(${lo})`);
      assert.equal(fn(hi), true, `${name}(${hi})`);
      if (hi > lo) assert.equal(fn(lo + 1 <= hi ? lo + Math.floor((hi - lo) / 2) : lo), true);
      if (lo > 0) assert.equal(fn(lo - 1), inRuns(runs, lo - 1), `${name}(${lo - 1})`);
      if (hi < 0x10ffff) assert.equal(fn(hi + 1), inRuns(runs, hi + 1), `${name}(${hi + 1})`);
    }
  }
});

test('full codepoint sweep of 13 predicates vs Go runs', () => {
  for (let r = 0; r <= 0x10ffff; r++) {
    for (const [name, fn] of Object.entries(predicates)) {
      const got = fn(r);
      const want = inRuns(go.predicates[name], r);
      if (got !== want) assert.equal(got, want, `${name}(U+${r.toString(16)})`);
    }
  }
});

test('isTable matches Go Is() runs for every named table (endpoints + samples)', () => {
  for (const name of go.tableNames) {
    const runs = tableRuns[name];
    assert.ok(runs, name);
    for (const [lo, hi] of runs) {
      assert.equal(isTable(name, lo), true, `${name} ${lo}`);
      assert.equal(isTable(name, hi), true, `${name} ${hi}`);
    }
    for (let r = 0; r <= 0x10ffff; r += 1024) {
      assert.equal(isTable(name, r), inRuns(runs, r), `${name} ${r}`);
    }
  }
});

test('full isTable sweep vs Go Is() compact runs for every named table', () => {
  for (const name of go.tableNames) {
    const runs = tableRuns[name];
    const lo = Uint32Array.from(runs, (row) => row[0]);
    const hi = Uint32Array.from(runs, (row) => row[1]);
    const mismatch = firstIsTableMismatch(name, lo, hi);
    assert.equal(mismatch, -1, `${name} mismatch at U+${(mismatch >>> 0).toString(16)}`);
  }
});

test('tablesOf / isOneOfTables / IsSpace vs Zs', () => {
  const latin = tablesOf(0x41);
  assert.ok(latin.includes('Latin'));
  assert.ok(latin.includes('L') || latin.includes('Letter'));
  assert.equal(isOneOfTables(['Cyrillic', 'Latin'], 0x41), true);
  assert.equal(isOneOfTables(['Cyrillic'], 0x41), false);
  assert.equal(isSpace(0xa0), true);
  assert.equal(isTable('Zs', 0xa0), true);
  assert.equal(isSpace(0x85), true);
});

test('simple case mapping matches Go non-identity list', () => {
  for (const [r, u, l, t, f] of go.caseNonIdentity) {
    assert.equal(toUpper(r), u, `ToUpper ${r}`);
    assert.equal(toLower(r), l, `ToLower ${r}`);
    assert.equal(toTitle(r), t, `ToTitle ${r}`);
    assert.equal(simpleFold(r), f, `SimpleFold ${r}`);
  }
  for (let r = 0; r < 128; r++) {
    const row = go.caseNonIdentity.find((row) => row[0] === r);
    if (!row) {
      assert.equal(toUpper(r), r >= 97 && r <= 122 ? r - 32 : r);
    }
  }
});

test('full codepoint sweep of ToUpper/ToLower/ToTitle/SimpleFold including identity', () => {
  assert.equal(go.caseNonIdentity.length, go.caseFull.nonIdentityCount);
  const packed = new Uint32Array(go.caseNonIdentity.length * 5);
  for (let i = 0; i < go.caseNonIdentity.length; i++) {
    const row = go.caseNonIdentity[i];
    packed[i * 5] = row[0] >>> 0;
    packed[i * 5 + 1] = row[1] >>> 0;
    packed[i * 5 + 2] = row[2] >>> 0;
    packed[i * 5 + 3] = row[3] >>> 0;
    packed[i * 5 + 4] = row[4] >>> 0;
  }
  const mismatch = firstCaseMismatch(packed);
  assert.equal(mismatch, -1, `case mismatch at U+${(mismatch >>> 0).toString(16)}`);
  assert.equal(caseFullChecksum(), go.caseFull.checksum);

  const nonId = new Set(go.caseNonIdentity.map((row) => row[0]));
  for (const r of [0, 0x20, 0x7f, 0x80, 0x4e00, 0x1f600, 0x10ffff]) {
    if (!nonId.has(r)) {
      assert.equal(toUpper(r), r, `identity ToUpper ${r}`);
      assert.equal(toLower(r), r, `identity ToLower ${r}`);
      assert.equal(toTitle(r), r, `identity ToTitle ${r}`);
      assert.equal(simpleFold(r), r, `identity SimpleFold ${r}`);
    }
  }
});

test('Turkish/Azeri special case; Dutch/Lithuanian fall back to default (Go has no tables)', () => {
  for (const [r, u, l, t] of go.specialCase.turkish) {
    assert.equal(toSpecialCase('turkish', 'upper', r), u);
    assert.equal(toSpecialCase('turkish', 'lower', r), l);
    assert.equal(toSpecialCase('turkish', 'title', r), t);
    assert.equal(toSpecialCase('azeri', 'upper', r), u);
  }
  assert.equal(toSpecialCase('dutch', 'upper', 0x69), toUpper(0x69));
  assert.equal(toSpecialCase('lithuanian', 'lower', 0x49), toLower(0x49));
});

test('JS simple-case differences from String.prototype', () => {
  assert.equal(String.fromCodePoint(toUpper(0xdf)), 'ß');
  assert.equal('ß'.toUpperCase(), 'SS');
  assert.equal(String.fromCodePoint(toUpper(0xfb01)), 'ﬁ');
  assert.equal('ﬁ'.toUpperCase(), 'FI');
  assert.equal(String.fromCodePoint(toLower(0x130)), 'i');
  assert.notEqual('İ'.toLowerCase(), 'i');
});

function fromHex(hex) {
  if (!hex) return new Uint8Array();
  return Uint8Array.from(hex.split(' ').map((b) => Number.parseInt(b, 16)));
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function recode(bytes) {
  // An invalid input byte expands to at most the three-byte RuneError encoding.
  // Copy each result immediately instead of retaining a typed array per rune.
  const out = new Uint8Array(bytes.length * 3);
  let offset = 0;
  for (const { r } of utf8Runes(bytes)) {
    const enc = utf8EncodeRune(r);
    out.set(enc, offset);
    offset += enc.length;
  }
  return out.slice(0, offset);
}

function checksumBytes(bytes) {
  let h = 2166136261;
  h = mix32(h, bytes.length >>> 0);
  for (let i = 0; i < bytes.length; i++) h = mix32(h, bytes[i]);
  return h >>> 0;
}

test('utf8 DecodeRune single-byte 0x00..0xFF matches Go', () => {
  for (const [b, r, size] of go.utf8.singleByte) {
    const got = utf8DecodeRune(Uint8Array.of(b));
    assert.equal(got.r, r, `byte ${b.toString(16)} r`);
    assert.equal(got.size, size, `byte ${b.toString(16)} size`);
  }
});

test('utf8 DecodeRune two-byte 0x80..0x7FF full + all C0-DF lead sequences match Go', () => {
  const two = go.utf8.twoByte;
  assert.equal(two.lo, 0x80);
  assert.equal(two.hi, 0x7ff);
  assert.equal(two.count, 0x7ff - 0x80 + 1);

  let encH = 2166136261;
  let canH = 2166136261;
  for (let r = two.lo; r <= two.hi; r++) {
    const encoded = utf8EncodeRune(r);
    assert.equal(encoded.length, 2, `EncodeRune U+${r.toString(16)} len`);
    const fromEnc = utf8DecodeRune(encoded);
    assert.equal(fromEnc.r, r, `encode-decode r U+${r.toString(16)}`);
    assert.equal(fromEnc.size, 2, `encode-decode size U+${r.toString(16)}`);
    encH = mix32(encH, fromEnc.r >>> 0);
    encH = mix32(encH, fromEnc.size >>> 0);

    const canonical = Uint8Array.of(0xc0 | (r >> 6), 0x80 | (r & 0x3f));
    const fromCan = utf8DecodeRune(canonical);
    assert.equal(fromCan.r, r, `canonical r U+${r.toString(16)}`);
    assert.equal(fromCan.size, 2, `canonical size U+${r.toString(16)}`);
    canH = mix32(canH, fromCan.r >>> 0);
    canH = mix32(canH, fromCan.size >>> 0);
  }
  assert.equal(encH, two.encodeDecodeChecksum);
  assert.equal(canH, two.canonicalDecodeChecksum);

  let seqH = 2166136261;
  let seqCount = 0;
  for (let b0 = 0xc0; b0 <= 0xdf; b0++) {
    for (let b1 = 0; b1 <= 0xff; b1++) {
      const got = utf8DecodeRune(Uint8Array.of(b0, b1));
      seqH = mix32(seqH, got.r >>> 0);
      seqH = mix32(seqH, got.size >>> 0);
      seqCount++;
    }
  }
  assert.equal(seqCount, two.allLeadSeqCount);
  assert.equal(seqH, two.allLeadSeqChecksum);
});

test('utf8 structural samples, RuneLen, Valid, round-trip', () => {
  for (const sample of go.utf8.samples) {
    const bytes = fromHex(sample.hex);
    const got = utf8DecodeRune(bytes);
    assert.equal(got.r, sample.r, sample.hex);
    assert.equal(got.size, sample.size, sample.hex);
    assert.equal(utf8Valid(bytes), sample.valid, sample.hex);
    assert.equal(toHex(recode(bytes)), sample.recodeHex, `recode ${sample.hex}`);
    if (sample.valid) assert.deepEqual([...recode(bytes)], [...bytes], `identity ${sample.hex}`);
  }
  for (const [r, n] of go.utf8.runeLen) {
    assert.equal(utf8RuneLen(r), n, `RuneLen ${r}`);
  }
  assert.equal(utf8RuneLen(0xd800), -1);
  assert.equal(utf8RuneLen(0x110000), -1);
  assert.equal(utf8RuneLen(utf8RuneError), 3);
  const encoded = utf8EncodeRune(0x1f600);
  const decoded = utf8DecodeRune(encoded);
  assert.equal(decoded.r, 0x1f600);
  assert.deepEqual([...utf8EncodeRune(decoded.r)], [...encoded]);
  assert.deepEqual([...utf8EncodeRune(0xd800)], [0xef, 0xbf, 0xbd]);
  assert.throws(() => utf8EncodeRuneStrict(0xd800), InvalidRuneError);
  const appended = utf8AppendRune(Uint8Array.of(0x41), 0x42);
  assert.deepEqual([...appended], [0x41, 0x42]);
});

test('utf8 last-rune, full-rune, runes iterator, validString', () => {
  const smile = utf8EncodeRune(0x1f600);
  assert.deepEqual(utf8DecodeLastRune(smile), { r: 0x1f600, size: 4 });
  assert.equal(utf8FullRune(smile.subarray(0, 2)), false);
  assert.equal(utf8FullRune(smile), true);
  assert.equal(utf8FullRune(Uint8Array.of(0xff)), true);
  const parts = [...utf8Runes(Uint8Array.from([0x41, 0xff, 0x42]))];
  assert.equal(parts.length, 3);
  assert.equal(parts[1].r, 0xfffd);
  assert.equal(parts[1].size, 1);
  assert.equal(utf8ValidString('A😀'), true);
  assert.equal(utf8ValidString('\uD83D'), false);
  assert.equal(utf8RuneStart(0x80), false);
  assert.equal(utf8RuneStart(0x41), true);
  assert.equal(utf8ValidRune(0xd800), false);
  assert.equal(utf8RuneCount(smile), 1);
});

function mix32(h, v) {
  return Math.imul((h ^ (v >>> 0)) >>> 0, 16777619) >>> 0;
}

test('utf16 encode/decode/surrogate parity with Go', () => {
  for (const row of go.utf16.encode) {
    const units = utf16Encode(Uint32Array.of(row.r >>> 0));
    assert.deepEqual([...units], row.units, `encode ${row.r}`);
  }
  for (const [r, n] of go.utf16.runeLen) {
    assert.equal(utf16RuneLen(r), n, `RuneLen ${r}`);
  }
  for (const [r, r1, r2] of go.utf16.encodeRune) {
    assert.deepEqual(utf16EncodeRune(r), { r1, r2 }, `EncodeRune ${r}`);
  }
  for (const [r, flag] of go.utf16.surrogate) {
    assert.equal(utf16IsSurrogate(r), flag);
  }
  assert.deepEqual([...utf16Decode(Uint16Array.of(0xd83d))], [0xfffd]);
  assert.deepEqual([...utf16Decode(Uint16Array.of(0xd83d, 0xde00))], [0x1f600]);
  assert.equal(utf16DecodeRune(0xd83d, 0xde00), 0x1f600);
  assert.equal(utf16DecodeRune(0xdbff, 0xdfff), 0x10ffff);
  assert.equal(utf16DecodeRune(0xdbff, 0xdc00), 0x10fc00);
  assert.deepEqual([...utf16Decode(utf16Encode(Uint32Array.of(0x10ffff)))], [0x10ffff]);
  assert.deepEqual([...utf16Decode(utf16Encode(Uint32Array.of(0x20000)))], [0x20000]);
  assert.notEqual(String.fromCodePoint ? '\uD83D'.codePointAt(0) : 0, 0xfffd);
});

test('utf16 full codepoint + surrogate-pair DecodeRune vs Go checksums', () => {
  const full = go.utf16.full;
  const runes = new Uint32Array(0x110000);
  for (let r = 0; r <= 0x10ffff; r++) runes[r] = r;
  const encoded = utf16Encode(runes);
  assert.equal(encoded.length, full.encodeAllLen);
  let encH = 2166136261;
  encH = mix32(encH, encoded.length);
  for (let i = 0; i < encoded.length; i++) encH = mix32(encH, encoded[i]);
  assert.equal(encH, full.encodeAllChecksum);

  let erH = 2166136261;
  let predH = 2166136261;
  for (let r = 0; r <= 0x10ffff; r++) {
    const { r1, r2 } = utf16EncodeRune(r);
    erH = mix32(erH, r1 >>> 0);
    erH = mix32(erH, r2 >>> 0);
    predH = mix32(predH, utf16IsSurrogate(r) ? 1 : 0);
    predH = mix32(predH, utf16RuneLen(r) >>> 0);
  }
  assert.equal(erH, full.encodeRuneChecksum);
  assert.equal(predH, full.predChecksum);

  const decoded = utf16Decode(encoded);
  let deH = 2166136261;
  deH = mix32(deH, decoded.length);
  for (let i = 0; i < decoded.length; i++) deH = mix32(deH, decoded[i]);
  assert.equal(deH, full.decodeEncodeChecksum);

  const bmp = new Uint16Array(0x10000);
  for (let i = 0; i <= 0xffff; i++) bmp[i] = i;
  const bmpDecoded = utf16Decode(bmp);
  assert.equal(bmpDecoded.length, full.decodeBmpLen);
  let bmpH = 2166136261;
  bmpH = mix32(bmpH, bmpDecoded.length);
  for (let i = 0; i < bmpDecoded.length; i++) bmpH = mix32(bmpH, bmpDecoded[i]);
  assert.equal(bmpH, full.decodeBmpChecksum);

  let pairH = 2166136261;
  for (let r1 = 0xd800; r1 <= 0xdfff; r1++) {
    for (let r2 = 0xd800; r2 <= 0xdfff; r2++) {
      pairH = mix32(pairH, utf16DecodeRune(r1, r2) >>> 0);
    }
  }
  assert.equal(pairH, full.decodeRuneSurrChecksum);
});

test('utf8 legal encode(decode(x))==x for every valid rune; concat checksum vs Go', () => {
  const rt = go.utf8.roundTrip;
  const all = new Uint8Array(rt.allValidLen);
  let offset = 0;
  for (let r = 0; r <= 0x10ffff; r++) {
    if (!utf8ValidRune(r)) continue;
    const enc = utf8EncodeRune(r);
    const again = recode(enc);
    assert.deepEqual([...again], [...enc], `roundtrip U+${r.toString(16)}`);
    all.set(enc, offset);
    offset += enc.length;
  }
  assert.equal(offset, rt.allValidLen);
  assert.equal(checksumBytes(all), rt.allValidChecksum);
  const redone = recode(all);
  assert.equal(rt.allValidRecodeEqual, true);
  assert.equal(redone.length, all.length);
  assert.equal(checksumBytes(redone), rt.allValidRecodeChecksum);
  assert.deepEqual(redone, all);
});

test('1 MiB LCG byte stream: Valid, RuneCount, and recode match Go and do not hang', () => {
  let x = 1;
  const buf = new Uint8Array(go.randomUtf8.len);
  for (let i = 0; i < buf.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    buf[i] = x >>> 24;
  }
  assert.equal(utf8Valid(buf), go.randomUtf8.valid);
  assert.equal(utf8RuneCount(buf), go.randomUtf8.runeCount);
  const redone = recode(buf);
  assert.equal(redone.length, go.randomUtf8.recodeLen);
  assert.equal(checksumBytes(redone), go.randomUtf8.recodeChecksum);
  assert.equal(utf8Valid(redone), go.randomUtf8.recodeValid);
  assert.equal(utf8RuneCount(redone), go.randomUtf8.recodeRuneCount);
  assert.equal(utf8RuneCount(redone), utf8RuneCount(buf));
});

test('typed-array slices and independent encode output', () => {
  const source = Uint8Array.from([0xff, 0x41, 0x42, 0xff]);
  const got = utf8DecodeRune(source.subarray(1, 3));
  assert.equal(got.r, 0x41);
  assert.equal(got.size, 1);
  const encoded = utf8EncodeRune(0x42);
  encoded[0] = 0;
  assert.equal(utf8EncodeRune(0x42)[0], 0x42);
});

test('TextDecoder vs utf8Valid: legal UTF-8 agrees; illegal is replaced by JS', () => {
  const ok = Uint8Array.from([0x41, 0xf0, 0x9f, 0x98, 0x80]);
  assert.equal(utf8Valid(ok), true);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(ok), 'A😀');
  const bad = Uint8Array.of(0xff);
  assert.equal(utf8Valid(bad), false);
  assert.equal(new TextDecoder('utf-8').decode(bad), '\uFFFD');
});
