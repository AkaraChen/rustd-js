import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { FileSet, PARSE_MODE, parseFile, astFprint, GoParseError } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./parse-edge-fixtures.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/gotool', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 64 << 20, timeout: 120000,
  });
}

function fprint(fset, node) {
  const chunks = [];
  astFprint({ write(c) { chunks.push(Buffer.from(c)); } }, fset, node);
  return Buffer.concat(chunks).toString('utf8');
}

function declCount(file) {
  if (file == null) return -1;
  return Array.isArray(file.decls) ? file.decls.length : 0;
}

function sameOrder(got, want) {
  if (got === want) return true;
  const lo = Math.min(got, want);
  const hi = Math.max(got, want);
  return hi <= Math.max(10, lo * 10);
}

function nativeParse(filename, src, mode) {
  const fset = new FileSet();
  try {
    const file = parseFile(fset, filename, src, mode);
    return { list: [], partialFile: file, fset, fprint: fprint(fset, file) };
  } catch (e) {
    assert.equal(e instanceof GoParseError, true, `${filename} threw ${e?.name ?? e}`);
    const printed = e.partialFile ? fprint(fset, e.partialFile) : '';
    return { list: e.list, partialFile: e.partialFile, fset, fprint: printed };
  }
}

const SUCCESS = new Set([
  'underscore-tparam',
  'deep-nest-32',
  'long-ident-2048',
  'gobuild-unclosed-paren',
  'gobuild-leading-and',
  'generic-nest',
  'generic-index-list',
]);

test('Go parse-edge fixture dump is stable (issue #28 §4.8)', () => {
  const generated = go(['-parse-edges']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go parse-edge fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool-parse-edges');
  assert.equal(fixture.go, 'go1.24.13');
  assert.equal(fixture.cases.length, 14);
});

test('native matches Go on remaining §4.8 long-line / //go:build syntax error / generic nesting', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const c of fixture.cases) {
    const src = Buffer.from(c.srcB64, 'base64');
    const got = nativeParse(c.filename, src, c.mode);
    assert.notEqual(got.partialFile, null, `${c.id} partialFile is null`);
    assert.equal(got.partialFile.nodeType, 'File', `${c.id} nodeType`);
    assert.equal(declCount(got.partialFile), c.declCount, `${c.id} declCount`);
    assert.equal(c.nilFile, false, `${c.id} Go returned a nil *ast.File`);
    if (SUCCESS.has(c.id)) {
      assert.equal(got.list.length, 0, `${c.id} unexpected native errors`);
      assert.equal(c.errors.length, 0, `${c.id} unexpected Go errors`);
      assert.equal(got.fprint, c.fprint, `${c.id} fprint mismatch`);
      continue;
    }
    assert.ok(c.errors.length > 0, `${c.id} Go reported no errors`);
    assert.ok(got.list.length > 0, `${c.id} native reported no errors`);
    assert.ok(
      sameOrder(got.list.length, c.errors.length),
      `${c.id} error count not same order native=${got.list.length} go=${c.errors.length}`,
    );
    const g0 = c.errors[0];
    const n0 = got.list[0];
    assert.equal(n0.line, g0.line, `${c.id} first line`);
    assert.equal(n0.column, g0.column, `${c.id} first column`);
    assert.equal(n0.offset, g0.offset, `${c.id} first offset`);
  }
});

test('JS extra §4.8 sources: Go verifies first pos, count, and declCount', () => {
  const extras = [
    ['js-empty', 'e.go', Buffer.from('')],
    ['js-comments-only', 'c.go', Buffer.from('/* x */\n')],
    ['js-unclosed-string', 's.go', Buffer.from('package p\nconst x = "\n')],
    ['js-long-string', 'long-string.go', Buffer.from(`package p\nvar s = "${'a'.repeat(16384)}"\n`)],
    ['js-gobuild-double-not', 'gobuild-not.go', Buffer.from('//go:build !!!\npackage p\nvar x int\n')],
    ['js-generic-index-expr', 'generic-index.go', Buffer.from('package p\nvar x = F[A[B[C[int]]]]\n')],
  ];
  const mode = PARSE_MODE.ParseComments | PARSE_MODE.SkipObjectResolution;
  const cases = extras.map(([id, filename, src]) => {
    const got = nativeParse(filename, src, mode);
    return {
      id,
      filename,
      srcB64: Buffer.from(src).toString('base64'),
      mode,
      kind: 'file',
      fprint: got.fprint,
      errors: got.list,
      declCount: declCount(got.partialFile),
      nilFile: got.partialFile == null,
    };
  });
  const packet = { schema: 1, package: 'gotool-parse-edges', go: 'js', cases };
  const verified = go(['-verify-parse-edges'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 6 gotool-parse-edges cases/);
});

test('deep nest over the native cap reports an error and does not abort', () => {
  const n = 4000;
  const src = Buffer.from(`package p\nvar x = ${'('.repeat(n)}1${')'.repeat(n)}\n`);
  const got = nativeParse('deep-over.go', src, PARSE_MODE.SkipObjectResolution);
  assert.ok(got.list.length > 0, 'expected nest-depth error');
  assert.ok(
    got.list.some((e) => e.msg.includes('exceeded max nesting depth')),
    `missing nest error: ${got.list.map((e) => e.msg).join('; ')}`,
  );
  assert.notEqual(got.partialFile, null);
});
