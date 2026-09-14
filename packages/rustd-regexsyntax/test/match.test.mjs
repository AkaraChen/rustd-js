import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { syntaxParse, FLAGS } from '../index.mjs';

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

const HAYSTACKS = [
  '',
  'a', 'A', 'b', 'B', 'c', 'C', 'd', 'e', 'x', 'z', 'Z',
  '0', '1', '2', '3',
  'ab', 'AB', 'Ab', 'aB', 'abc', 'ABC', 'bcd',
  'aa', 'aaa', 'aaaa',
  'word', 'Word', 'WORD', 'sword', 'words', 'a word b', ' word ',
  'foo', 'bar', 'foobar',
  'a\nb', '\n', 'a\n', '\na',
  ' ', '\t', '-', '{', '}',
  'α', 'ε', '☺', '日本語',
  'xab1', '0abc1', 'abc1', 'de', 'cd',
];

test('JS parse -> toString -> Go regexp.Compile match equals original (issue #30 §4.2)', () => {
  const packet = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const cases = packet.cases.filter((c) => c.flags === FLAGS.Perl && !c.error && !c.patternHex);
  assert.ok(cases.length >= 50, `perl cases ${cases.length}`);
  const rewritten = cases.filter((c) => c.printed !== c.pattern);
  assert.ok(rewritten.length >= 20, `rewritten ${rewritten.length}`);

  const matchCases = cases.map((c) => {
    const re = syntaxParse(c.pattern, c.flags);
    const printed = re.toString();
    assert.equal(printed, c.printed, `${c.id} toString want ${c.printed}`);
    const haystacks = HAYSTACKS.includes(c.pattern) ? HAYSTACKS : [...HAYSTACKS, c.pattern];
    return {
      id: c.id,
      pattern: c.pattern,
      flags: c.flags,
      printed,
      haystacks,
    };
  });

  const verified = go(['-pkg', 'regexsyntax-match', '-verify'], JSON.stringify({
    schema: 1,
    package: 'regexsyntax-match',
    cases: matchCases,
  }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ regexsyntax-match cases/);
});
