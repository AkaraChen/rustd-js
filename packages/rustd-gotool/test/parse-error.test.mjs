import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { FileSet, parseFile, GoParseError } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./parse-error-fixtures.json', import.meta.url);
const msgDiffPath = new URL('./parse-error-msg-diffs.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/gotool', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 64 << 20, timeout: 120000,
  });
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

function nativeErrors(filename, src, mode) {
  const fset = new FileSet();
  try {
    const file = parseFile(fset, filename, src, mode);
    return { list: [], partialFile: file };
  } catch (e) {
    assert.equal(e instanceof GoParseError, true, `${filename} threw ${e?.name ?? e}`);
    return { list: e.list, partialFile: e.partialFile };
  }
}

test('Go parse-error fixture dump is stable', () => {
  const generated = go(['-parse-errors']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go parse-error fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool-parse-errors');
  assert.equal(fixture.go, 'go1.24.13');
  assert.equal(fixture.cases.length, 20);
});

test('GoParseError.list first position and count vs Go; partialFile decls match (issue #28 §4.5)', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const msgDiffs = [];
  for (const c of fixture.cases) {
    const src = Buffer.from(c.srcB64, 'base64');
    const got = nativeErrors(c.filename, src, c.mode);
    assert.notEqual(got.partialFile, null, `${c.id} partialFile is null`);
    assert.equal(got.partialFile.nodeType, 'File', `${c.id} partialFile.nodeType`);
    assert.equal(declCount(got.partialFile), c.declCount, `${c.id} declCount`);
    assert.equal(c.nilFile, false, `${c.id} Go returned a nil *ast.File`);
    assert.ok(c.errors.length > 0, `${c.id} Go reported no errors`);
    assert.ok(got.list.length > 0, `${c.id} native reported no errors`);
    assert.ok(
      sameOrder(got.list.length, c.errors.length),
      `${c.id} error count not same order of magnitude native=${got.list.length} go=${c.errors.length}`,
    );
    const g0 = c.errors[0];
    const n0 = got.list[0];
    assert.equal(n0.line, g0.line, `${c.id} first line`);
    assert.equal(n0.column, g0.column, `${c.id} first column`);
    assert.equal(n0.offset, g0.offset, `${c.id} first offset`);
    const n = Math.max(got.list.length, c.errors.length);
    for (let i = 0; i < n; i++) {
      const ge = c.errors[i];
      const ne = got.list[i];
      if (!ge || !ne || ge.msg !== ne.msg || ge.line !== ne.line || ge.column !== ne.column || ge.offset !== ne.offset) {
        msgDiffs.push({
          id: c.id,
          i,
          go: ge ?? null,
          native: ne ?? null,
        });
      }
    }
  }
  // Wording is not a pass/fail criterion; keep the recorded diffs as evidence.
  const committedDiffs = JSON.parse(readFileSync(msgDiffPath, 'utf8'));
  assert.equal(committedDiffs.package, 'gotool-parse-errors-msg-diffs');
  assert.deepEqual(committedDiffs.cases, msgDiffs, 'parse-error message-diff snapshot drift');
});

test('JS extra broken sources: Go verifies first pos, count, and declCount', () => {
  const extras = [
    ['js-missing-brace', 'x.go', 'package p\nfunc F() {\n'],
    ['js-bad-for', 'y.go', 'package p\nfunc F() { for {= } }\n'],
  ];
  const mode = 4 | 64; // ParseComments | SkipObjectResolution
  const cases = extras.map(([id, filename, text]) => {
    const src = Buffer.from(text);
    const got = nativeErrors(filename, src, mode);
    return {
      id,
      filename,
      srcB64: src.toString('base64'),
      mode,
      errors: got.list,
      declCount: declCount(got.partialFile),
      nilFile: got.partialFile == null,
    };
  });
  const packet = { schema: 1, package: 'gotool-parse-errors', go: 'js', cases };
  const verified = go(['-verify-parse-errors'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 2 gotool-parse-errors cases/);
});
