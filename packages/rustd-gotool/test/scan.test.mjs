import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  TOKEN,
  SCAN_MODE,
  tokenLookup,
  tokenIsKeyword,
  tokenIsExported,
  tokenString,
  FileSet,
  Scanner,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./scan-fixtures.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/gotool', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 64 << 20, timeout: 120000,
  });
}

function litFromB64(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

function scanAll(filename, src, mode, onError) {
  const fset = new FileSet();
  const file = fset.addFile(filename, fset.base(), src.length);
  const scanner = new Scanner(file, src, onError ?? null, mode);
  const tokens = [];
  for (;;) {
    const t = scanner.scan();
    const pos = file.position(t.pos);
    tokens.push({
      pos: t.pos,
      tok: t.tok,
      lit: t.lit,
      line: pos.line,
      column: pos.column,
      filename: pos.filename,
    });
    if (t.tok === TOKEN.EOF) break;
  }
  return { tokens, errorCount: scanner.errorCount, fset, file };
}

test('TOKEN numbers match Go 1.24 iota dump in committed fixtures', () => {
  const generated = go(['-scan']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go scan fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool-scan');
  assert.equal(fixture.go, 'go1.24.13');
  for (const [k, v] of Object.entries(fixture.tokens)) {
    assert.equal(TOKEN[k], v, `TOKEN.${k}`);
    assert.equal(tokenString(v), tokenString(TOKEN[k]));
  }
  assert.equal(tokenLookup('func'), TOKEN.FUNC);
  assert.equal(tokenLookup('notAKeyword'), TOKEN.IDENT);
  assert.equal(tokenIsKeyword(TOKEN.FUNC), true);
  assert.equal(tokenIsKeyword(TOKEN.IDENT), false);
  assert.equal(tokenIsExported('Fmt'), true);
  assert.equal(tokenIsExported('fmt'), false);
  assert.equal(tokenString(TOKEN.ADD), '+');
  assert.equal(SCAN_MODE.ScanComments, 1);
});

test('native scanner matches Go dump (pos, tok, lit, line, column) on every case', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.ok(fixture.cases.length >= 20, `too few scan cases: ${fixture.cases.length}`);
  for (const c of fixture.cases) {
    const src = new Uint8Array(Buffer.from(c.srcB64, 'base64'));
    const { tokens } = scanAll(c.filename, src, c.mode);
    assert.equal(tokens.length, c.tokens.length, `${c.id} token count`);
    for (let i = 0; i < tokens.length; i++) {
      const got = tokens[i];
      const want = c.tokens[i];
      const wantLit = litFromB64(want.litB64);
      assert.equal(got.pos, want.pos, `${c.id}#${i} pos tok=${want.tok}`);
      assert.equal(got.tok, want.tok, `${c.id}#${i} tok`);
      assert.equal(got.lit, wantLit, `${c.id}#${i} lit tok=${want.tok}`);
      assert.equal(got.line, want.line, `${c.id}#${i} line`);
      assert.equal(got.column, want.column, `${c.id}#${i} column`);
      assert.equal(got.filename, want.filename, `${c.id}#${i} filename`);
    }
  }
});

test('JS extra sources scan natively then Go verifies the dump packet', () => {
  const extras = [
    ['js-hello', 'h.go', 'package main\nfunc main() {}\n', SCAN_MODE.ScanComments],
    ['js-semi', 's.go', 'x\n', SCAN_MODE.ScanComments],
    ['js-raw', 'r.go', 'package p\nvar s = `a\nb`\n', SCAN_MODE.ScanComments],
  ];
  const cases = extras.map(([id, filename, text, mode]) => {
    const src = Buffer.from(text);
    const { tokens } = scanAll(filename, src, mode);
    return {
      id,
      filename,
      srcB64: src.toString('base64'),
      mode,
      tokens: tokens.map((t) => ({
        pos: t.pos,
        tok: t.tok,
        litB64: Buffer.from(t.lit, 'utf8').toString('base64'),
        line: t.line,
        column: t.column,
        filename: t.filename,
      })),
      errors: [],
    };
  });
  const packet = {
    schema: 1,
    package: 'gotool-scan',
    go: 'js',
    tokens: { ...TOKEN },
    cases,
  };
  const verified = go(['-verify-scan'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 3 gotool-scan cases/);
  const broken = structuredClone(packet);
  broken.cases[0].tokens[0].tok = 99;
  const rejected = go(['-verify-scan'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /mismatch case 0/);
});

test('scanInto reuses the result object; FileSet.iterate visits added files', () => {
  const src = Buffer.from('package p\n');
  const fset = new FileSet();
  const file = fset.addFile('p.go', -1, src.length);
  const scanner = new Scanner(file, src, null, SCAN_MODE.ScanComments);
  const out = { pos: 0, tok: 0, lit: '' };
  scanner.scanInto(out);
  assert.equal(out.tok, TOKEN.PACKAGE);
  assert.equal(out.lit, 'package');
  const names = [];
  fset.iterate((f) => {
    names.push(f.name());
  });
  assert.deepEqual(names, ['p.go']);
  assert.equal(file.lineCount() >= 1, true);
});

test('error handler is invoked for NUL; scanInto TypeError on bad out', () => {
  const src = Buffer.from('package p\n\x00');
  const fset = new FileSet();
  const file = fset.addFile('n.go', -1, src.length);
  const msgs = [];
  const scanner = new Scanner(file, src, (pos, msg) => msgs.push({ pos, msg }), SCAN_MODE.ScanComments);
  while (scanner.scan().tok !== TOKEN.EOF) {}
  assert.ok(scanner.errorCount >= 1);
  assert.ok(msgs.some((m) => m.msg.includes('NUL')));
  assert.throws(() => scanner.scanInto(null), TypeError);
});
