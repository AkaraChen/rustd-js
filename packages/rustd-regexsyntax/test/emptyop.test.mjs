import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { emptyOpContext, isWordChar, EMPTY_OP } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/emptyop.json', import.meta.url);

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

test('Go regenerates committed emptyop fixtures; EmptyOpContext/IsWordChar match', () => {
  const generated = go(['-pkg', 'regexsyntax-emptyop']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go regexsyntax-emptyop fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'regexsyntax-emptyop');
  assert.ok(packet.word.length >= 128, `word ${packet.word.length}`);
  assert.ok(packet.pairs.length >= 400, `pairs ${packet.pairs.length}`);

  for (const c of packet.word) {
    assert.equal(isWordChar(c.r), c.word, `${c.id} IsWordChar(${c.r})`);
  }
  for (const c of packet.pairs) {
    const got = emptyOpContext(c.r1, c.r2);
    assert.equal(got, c.context, `${c.id} EmptyOpContext(${c.r1},${c.r2}) got ${got} want ${c.context}`);
    assert.equal(isWordChar(c.r1), c.word1, `${c.id} word1`);
    assert.equal(isWordChar(c.r2), c.word2, `${c.id} word2`);
  }
});

test('JS-generated emptyop cases verify against Go', () => {
  const runes = [-1, 10, 97, 32, 0xe9];
  const word = runes.map((r) => ({ id: `js-w-${r}`, r, word: isWordChar(r) }));
  const pairs = [];
  for (const r1 of runes) {
    for (const r2 of runes) {
      pairs.push({
        id: `js-p-${r1}-${r2}`,
        r1,
        r2,
        context: emptyOpContext(r1, r2),
        word1: isWordChar(r1),
        word2: isWordChar(r2),
      });
    }
  }
  const verified = go(['-pkg', 'regexsyntax-emptyop', '-verify'], JSON.stringify({
    schema: 1, package: 'regexsyntax-emptyop', pairs, word,
  }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 25 emptyop pairs \+ 5 word cases/);
});

test('EmptyOpContext begin/end text bits', () => {
  const begin = emptyOpContext(-1, 97);
  assert.equal(begin & EMPTY_OP.BeginText, EMPTY_OP.BeginText);
  assert.equal(begin & EMPTY_OP.BeginLine, EMPTY_OP.BeginLine);
  assert.equal(begin & EMPTY_OP.WordBoundary, EMPTY_OP.WordBoundary);
  const end = emptyOpContext(97, -1);
  assert.equal(end & EMPTY_OP.EndText, EMPTY_OP.EndText);
  assert.equal(end & EMPTY_OP.EndLine, EMPTY_OP.EndLine);
  const both = emptyOpContext(-1, -1);
  assert.equal(both & EMPTY_OP.BeginText, EMPTY_OP.BeginText);
  assert.equal(both & EMPTY_OP.EndText, EMPTY_OP.EndText);
  assert.equal(both & EMPTY_OP.NoWordBoundary, EMPTY_OP.NoWordBoundary);
});

test('IsWordChar is ASCII-only', () => {
  assert.equal(isWordChar(97), true);
  assert.equal(isWordChar(0x17f), false);
  assert.equal(isWordChar(0x4e2d), false);
  assert.equal(isWordChar(-1), false);
});

test('type errors', () => {
  assert.throws(() => emptyOpContext('a', 1), TypeError);
  assert.throws(() => emptyOpContext(1, 1.5), TypeError);
  assert.throws(() => isWordChar(null), TypeError);
});
