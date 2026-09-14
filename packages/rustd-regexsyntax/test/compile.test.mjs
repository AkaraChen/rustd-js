import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { syntaxCompile, syntaxParse, FLAGS, INST_OP, EMPTY_OP } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/compile.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', '.', ...args], {
    cwd: resolve(root, 'packages/rustd-regexsyntax/gofixtures'),
    encoding: 'utf8',
    input,
    maxBuffer: 32 << 20,
    timeout: 120000,
    env: { ...process.env, GOWORK: 'off' },
  });
  if (result.error) throw result.error;
  return result;
}

function firstDiff(got, want, path) {
  if (got === want) return null;
  if (typeof got !== typeof want) return `${path}: type ${typeof got} vs ${typeof want}`;
  if (Array.isArray(got) && Array.isArray(want)) {
    if (got.length !== want.length) return `${path}: length ${got.length} vs ${want.length}`;
    for (let i = 0; i < got.length; i++) {
      const d = firstDiff(got[i], want[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (got && want && typeof got === 'object') {
    const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
    for (const k of keys) {
      const d = firstDiff(got[k], want[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`;
}

test('Go regenerates committed compile fixtures; Prog.Inst matches field-level', () => {
  const generated = go(['-pkg', 'regexsyntax-compile']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go regexsyntax-compile fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'regexsyntax-compile');
  assert.ok(packet.cases.length >= 16, `cases ${packet.cases.length}`);

  for (const c of packet.cases) {
    const prog = syntaxCompile(c.pattern, c.flags);
    assert.equal(prog.dump, c.dump, `${c.id} dump\n--- have\n${prog.dump}--- want\n${c.dump}`);
    assert.equal(prog.start, c.start, `${c.id} start`);
    assert.equal(prog.numCap, c.numCap, `${c.id} numCap`);
    const diff = firstDiff(prog.inst, c.inst, `${c.id}.inst`);
    assert.equal(diff, null, diff);
    const via = syntaxParse(c.pattern, c.flags).compile();
    assert.equal(via.dump, c.dump, `${c.id} SyntaxRegexp.compile dump`);
  }
});

test('JS-generated compile dumps verify against Go', () => {
  const cases = [
    { id: 'js-a', pattern: 'a', flags: FLAGS.Perl },
    { id: 'js-alt', pattern: 'a+|b+', flags: FLAGS.Perl },
    { id: 'js-star', pattern: '(?:|a)*', flags: FLAGS.Perl },
  ].map((c) => {
    const prog = syntaxCompile(c.pattern, c.flags);
    return { ...c, dump: prog.dump, start: prog.start, numCap: prog.numCap, inst: prog.inst };
  });
  const verified = go(['-pkg', 'regexsyntax-compile', '-verify'], JSON.stringify({
    schema: 1, package: 'regexsyntax-compile', cases,
  }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 3 regexsyntax-compile cases/);
});

test('INST_OP / EMPTY_OP match Go iota', () => {
  assert.equal(INST_OP.Alt, 0);
  assert.equal(INST_OP.RuneAnyNotNL, 10);
  assert.equal(EMPTY_OP.BeginText, 4);
  assert.equal(EMPTY_OP.NoWordBoundary, 32);
});

test('type errors', () => {
  assert.throws(() => syntaxCompile(1, FLAGS.Perl), TypeError);
  assert.throws(() => syntaxCompile('a', 'x'), TypeError);
});
