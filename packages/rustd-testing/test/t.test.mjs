import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T, FATAL, FatalError, SkipError, TestSetupError } from '../index.mjs';

const pkgDir = dirname(fileURLToPath(import.meta.url));
const root = join(pkgDir, '..');
const require = createRequire(import.meta.url);

test('CJS and ESM export the same T and FATAL', () => {
  const cjs = require('../index.js');
  assert.equal(cjs.T, T);
  assert.equal(cjs.FATAL, FATAL);
  assert.equal(cjs.FatalError, FatalError);
});

test('cleanup is LIFO and still runs after skip', async () => {
  const order = [];
  const ok = await T.start('Cleanup', async (t) => {
    t.cleanup(() => { order.push('a'); });
    t.cleanup(async () => { order.push('b'); });
    t.cleanup(() => { order.push('c'); });
    t.skip('later');
    order.push('unreachable');
  });
  assert.equal(ok, true);
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('subtest failure sets parent failed() without failNow', async () => {
  let continued = false;
  const ok = await T.start('Parent', async (t) => {
    const childOk = await t.run('child', (child) => {
      child.error('boom');
    });
    assert.equal(childOk, false);
    assert.equal(t.failed(), true);
    continued = true;
  });
  assert.equal(ok, false);
  assert.equal(continued, true);
});

test('fatal stops later statements in the same test', async () => {
  let after = false;
  const ok = await T.start('Fatal', (t) => {
    t.fatal('stop');
    after = true;
  });
  assert.equal(ok, false);
  assert.equal(after, false);
});

test('swallowed FatalError still fails because of the flag and FATAL mark', async () => {
  const ok = await T.start('Swallow', (t) => {
    try {
      t.failNow();
    } catch (err) {
      assert.equal(err[FATAL], true);
      assert.equal(err instanceof FatalError, true);
    }
  });
  assert.equal(ok, false);
});

test('nested name() matches Go TestA/sub/sub2', async () => {
  await T.start('TestA', async (t) => {
    assert.equal(t.name(), 'TestA');
    await t.run('sub', async (t2) => {
      assert.equal(t2.name(), 'TestA/sub');
      await t2.run('sub2', (t3) => {
        assert.equal(t3.name(), 'TestA/sub/sub2');
      });
    });
  });
});

test('tempDir is created then removed; outside a test it throws', async () => {
  assert.throws(() => new T('idle').tempDir(), TestSetupError);
  let dir;
  await T.start('Temp', (t) => {
    dir = t.tempDir();
    assert.equal(existsSync(dir), true);
  });
  assert.equal(existsSync(dir), false);
});

test('setenv restores and is forbidden after parallel', async () => {
  const key = 'RUSTD_TESTING_SETENV';
  delete process.env[key];
  await T.start('Env', (t) => {
    t.setenv(key, 'one');
    assert.equal(process.env[key], 'one');
  });
  assert.equal(process.env[key], undefined);

  await T.start('EnvParallel', (t) => {
    t.parallel();
    assert.throws(() => t.setenv(key, 'nope'), /parallel cannot use t.setenv/);
  });

  await T.start('EnvThenParallel', (t) => {
    t.setenv(key, 'x');
    assert.throws(() => t.parallel(), /cannot use t.parallel/);
  });
  assert.equal(process.env[key], undefined);
});

test('chdir restores and is forbidden after parallel', async () => {
  const original = process.cwd();
  await T.start('Chdir', (t) => {
    const dir = t.tempDir();
    t.chdir(dir);
    assert.equal(process.cwd(), dir);
  });
  assert.equal(process.cwd(), original);

  await T.start('ChdirParallel', (t) => {
    t.parallel();
    assert.throws(() => t.chdir(tmpdir()), /parallel cannot use t.chdir/);
  });
});

test('cleanup errors fail the test; failNow in cleanup is recorded; later cleanups still run', async () => {
  const order = [];
  const ok = await T.start('CleanupFail', (t) => {
    t.cleanup(() => { order.push('late'); });
    t.cleanup(() => { t.failNow(); });
    t.cleanup(() => { order.push('early-throw'); throw new Error('cleanup boom'); });
  });
  assert.equal(ok, false);
  assert.deepEqual(order, ['early-throw', 'late']);
});

test('context() aborts when the test ends', async () => {
  let signal;
  await T.start('Ctx', (t) => {
    signal = t.context();
    assert.equal(signal.aborted, false);
    const [deadline, ok] = t.deadline();
    assert.equal(deadline, null);
    assert.equal(ok, false);
  });
  assert.equal(signal.aborted, true);
});

test('SkipError is thrown by skip and does not fail the test', async () => {
  const ok = await T.start('Skip', (t) => {
    try {
      t.skipf('why %s', 'not');
    } catch (err) {
      assert.equal(err instanceof SkipError, true);
      throw err;
    }
  });
  assert.equal(ok, true);
});

test('forgetting to await t.run emits RUSTD_TESTING_UNAWAITED_RUN', async () => {
  const seen = [];
  const onWarning = (warning) => { seen.push(warning); };
  process.on('warning', onWarning);
  try {
    await T.start('Una awaited', (t) => {
      t.run('lost', () => {});
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', onWarning);
  }
  assert.ok(
    seen.some((w) => w.code === 'RUSTD_TESTING_UNAWAITED_RUN' && String(w).includes('not awaited')),
    `expected una waited warning, got ${seen.map((w) => w.code).join(',') || 'none'}`,
  );
});

test('T.Run toStringTag is present on run() promises', async () => {
  await T.start('Tag', async (t) => {
    const p = t.run('child', () => {});
    assert.equal(Object.prototype.toString.call(p), '[object T.Run]');
    await p;
  });
});

test('pure JS package produces no .node binary', () => {
  const binaries = readdirSync(root).filter((name) => name.endsWith('.node'));
  assert.deepEqual(binaries, []);
});

test('errorf uses util.format, not Go fmt', async () => {
  const ok = await T.start('Fmt', (t) => {
    t.errorf('%s %j', 'n', { a: 1 });
  });
  assert.equal(ok, false);
});

test('packed tarball loads in CJS and ESM and contains no native binary', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const npmCli = join(process.execPath, platformNpm());
  const temp = mkdtempSync(join(tmpdir(), 'rustd-testing-pack-'));
  try {
    const pack = spawnSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', temp], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(pack.status, 0, pack.stderr);
    const [meta] = JSON.parse(pack.stdout);
    assert.equal(meta.files.some((f) => f.path.endsWith('.node')), false);
    const consumer = join(temp, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true}');
    const install = spawnSync(
      process.execPath,
      [npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, meta.filename)],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(install.status, 0, install.stderr);
    const cjs = spawnSync(
      process.execPath,
      ['-e', 'const m=require("rustd-testing"); if (typeof m.T.start !== "function") process.exit(2);'],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(cjs.status, 0, cjs.stderr);
    const esm = spawnSync(
      process.execPath,
      ['-e', 'import("rustd-testing").then(m=>{if(typeof m.T.start!=="function")process.exit(2)})'],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(esm.status, 0, esm.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function platformNpm() {
  if (process.platform === 'win32') return '../node_modules/npm/bin/npm-cli.js';
  return '../../lib/node_modules/npm/bin/npm-cli.js';
}

void pathToFileURL;
