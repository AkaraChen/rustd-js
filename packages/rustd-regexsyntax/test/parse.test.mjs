import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { syntaxParse, FLAGS, OP, flagsToString, SyntaxError } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/parse.json', import.meta.url);

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

test('Go regenerates committed parse fixtures; native dump and String match', () => {
  const generated = go(['-pkg', 'regexsyntax']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go regexsyntax fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'regexsyntax');
  assert.ok(packet.cases.length >= 95, `cases ${packet.cases.length}`);
  const pCases = packet.cases.filter((c) => /\\p|\\P/.test(c.pattern));
  assert.ok(pCases.length >= 14, `p-cases ${pCases.length}`);

  for (const c of packet.cases) {
    if (c.error) {
      assert.throws(() => syntaxParse(c.pattern, c.flags), (err) => {
        assert.equal(err instanceof SyntaxError, true, `${c.id} class`);
        assert.equal(err.code, c.error, `${c.id} code`);
        return true;
      }, c.id);
      continue;
    }
    const re = syntaxParse(c.pattern, c.flags);
    assert.equal(re.dump(), c.dump, `${c.id} dump want ${c.dump}`);
    assert.equal(re.toString(), c.printed, `${c.id} String want ${c.printed}`);
  }
});

test('JS-generated parse dumps verify against Go', () => {
  const cases = [
    { id: 'js-ab', pattern: 'ab', flags: FLAGS.MatchNL | FLAGS.PerlX | FLAGS.UnicodeGroups },
    { id: 'js-alt', pattern: 'foo|bar', flags: FLAGS.MatchNL | FLAGS.PerlX | FLAGS.UnicodeGroups },
    { id: 'js-star', pattern: 'a(b)*c', flags: FLAGS.Perl },
  ].map((c) => {
    const re = syntaxParse(c.pattern, c.flags);
    return { ...c, dump: re.dump(), printed: re.toString() };
  });
  const verified = go(['-pkg', 'regexsyntax', '-verify'], JSON.stringify({
    schema: 1, package: 'regexsyntax', cases,
  }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 3 regexsyntax cases/);
});

test('OP/FLAGS match Go iota and Perl bitmask', () => {
  assert.equal(OP.NoMatch, 1);
  assert.equal(OP.Alternate, 19);
  assert.equal(FLAGS.FoldCase, 1);
  assert.equal(FLAGS.Perl, FLAGS.ClassNL | FLAGS.OneLine | FLAGS.PerlX | FLAGS.UnicodeGroups);
  assert.equal(FLAGS.Perl, 212);
  assert.match(flagsToString(FLAGS.Perl), /PerlX/);
});

test('type errors', () => {
  assert.throws(() => syntaxParse(1, FLAGS.Perl), TypeError);
  assert.throws(() => syntaxParse('a', 'x'), TypeError);
});
