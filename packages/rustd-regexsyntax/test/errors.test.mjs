import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntaxParse, FLAGS, ERROR_CODE, SyntaxError } from '../index.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(pkgDir, '../..');
const fixturePath = new URL('./fixtures/errors.json', import.meta.url);

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

test('ERROR_CODE strings and trigger samples match Go regexp/syntax', () => {
  const generated = go(['-pkg', 'regexsyntax-errors']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go regexsyntax error fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'regexsyntax-errors');
  assert.equal(packet.codes.length, 16);

  const jsCodes = { ...ERROR_CODE };
  const seen = new Set();
  for (const row of packet.codes) {
    assert.equal(ERROR_CODE[row.name], row.code, row.name);
    delete jsCodes[row.name];
  }
  assert.deepEqual(jsCodes, {});

  for (const c of packet.cases) {
    seen.add(c.error);
    if (!c.nativeParse) {
      assert.equal(c.error, ERROR_CODE.InvalidUTF8, c.id);
      continue;
    }
    assert.throws(() => syntaxParse(c.pattern, c.flags), (err) => {
      assert.equal(err instanceof SyntaxError, true, `${c.id} class`);
      assert.equal(err.code, c.error, `${c.id} code want ${c.error} got ${err.code}`);
      assert.equal(err.expr, c.expr ?? '', `${c.id} expr`);
      return true;
    }, c.id);
  }

  for (const row of packet.codes) {
    if (row.used) assert.equal(seen.has(row.code), true, `missing trigger ${row.name}`);
  }

  const verified = go(['-pkg', 'regexsyntax-errors', '-verify'], committed);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 16 regexsyntax error codes/);
});

test('1500 nested parens throw ErrNestingDepth in a child process (not SIGSEGV)', () => {
  const script = `
    const { syntaxParse, FLAGS, ERROR_CODE, SyntaxError } = require(${JSON.stringify(resolve(pkgDir, 'index.js'))});
    const pattern = '('.repeat(1500) + ')'.repeat(1500);
    try {
      syntaxParse(pattern, FLAGS.Perl);
      console.error('expected SyntaxError');
      process.exit(2);
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.error('not SyntaxError', err && err.stack || err);
        process.exit(3);
      }
      if (err.code !== ERROR_CODE.NestingDepth) {
        console.error('code', err.code);
        process.exit(4);
      }
      console.log('OK');
    }
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 << 20,
  });
  assert.equal(child.signal, null, `child signal ${child.signal} stderr=${child.stderr}`);
  assert.notEqual(child.signal, 'SIGSEGV');
  assert.notEqual(child.signal, 'SIGABRT');
  assert.equal(child.status, 0, `status=${child.status} stdout=${child.stdout} stderr=${child.stderr}`);
  assert.match(child.stdout, /^OK$/m);
});
