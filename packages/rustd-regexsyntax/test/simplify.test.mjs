import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { syntaxParse, syntaxSimplify, FLAGS } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/simplify.json', import.meta.url);
const simplifyFlags = FLAGS.MatchNL | FLAGS.PerlX | FLAGS.UnicodeGroups;

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

test('Go regenerates committed simplify fixtures; dump and String match', () => {
  const generated = go(['-pkg', 'regexsyntax-simplify']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go regexsyntax-simplify fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'regexsyntax-simplify');
  assert.ok(packet.cases.length >= 90, `cases ${packet.cases.length}`);

  for (const c of packet.cases) {
    const re = syntaxSimplify(c.pattern, c.flags);
    assert.equal(re.dump(), c.dump, `${c.id} dump want ${c.dump} got ${re.dump()}`);
    assert.equal(re.toString(), c.printed, `${c.id} String want ${c.printed} got ${re.toString()}`);
    const via = syntaxParse(c.pattern, c.flags).simplify();
    assert.equal(via.dump(), c.dump, `${c.id} SyntaxRegexp.simplify dump`);
    assert.equal(via.toString(), c.printed, `${c.id} SyntaxRegexp.simplify String`);
  }
});

test('JS-generated simplify dumps verify against Go', () => {
  const cases = [
    { id: 'js-a2', pattern: 'a{2}', flags: simplifyFlags },
    { id: 'js-rep', pattern: '(a){2,6}', flags: simplifyFlags },
    { id: 'js-starplus', pattern: '(?:a{1,})+', flags: simplifyFlags },
  ].map((c) => {
    const re = syntaxSimplify(c.pattern, c.flags);
    return { ...c, dump: re.dump(), printed: re.toString() };
  });
  const verified = go(['-pkg', 'regexsyntax-simplify', '-verify'], JSON.stringify({
    schema: 1, package: 'regexsyntax-simplify', cases,
  }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 3 regexsyntax-simplify cases/);
});

test('type errors', () => {
  assert.throws(() => syntaxSimplify(1, simplifyFlags), TypeError);
  assert.throws(() => syntaxSimplify('a', 'x'), TypeError);
});
