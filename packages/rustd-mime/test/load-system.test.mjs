import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  typeByExtension, extensionsByType, loadSystemMimeTypes,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixtureDir = mkdtempSync(join(tmpdir(), 'rustd-mime-ck6-'));
const typesFile = join(fixtureDir, 'test.types');
const globsFile = join(fixtureDir, 'test.types.globs2');
writeFileSync(typesFile, `# mime package test
application/x-rustd-mime-ck6-t1	rustdck6t1	# Simple test
text/x-rustd-mime-ck6-t2		rustdck6t2	# Text test
application/x-rustd-mime-ck6-multi	rustdck6a	rustdck6b
# skipped
application/x-rustd-mime-ck6-hash	rustdck6h	# trailing
`);
writeFileSync(globsFile, `# mime package test for globs2
50:application/x-rustd-mime-ck6-t3:*.rustdck6t3
50:application/x-rustd-mime-ck6-t4:*.rustdck6t4
50:text/plain:*,v
50:application/x-trash:*~
30:application/x-rustd-mime-ck6-t4-later:*.rustdck6t4
10:application/x-rustd-mime-ck6-glob-q:*.rustdck6foo?ar
10:application/x-rustd-mime-ck6-glob-a:*.rustdck6foo*r
10:application/x-rustd-mime-ck6-glob-r:*.rustdck6foo[1-3]
`);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/mime', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20,
    env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 120000,
  });
}

test('platform default TypeByExtension / ExtensionsByType match Go (issue #9 §3)', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const fixture = JSON.parse(generated.stdout);
  assert.ok(fixture.ext.length >= 30, `ext cases ${fixture.ext.length}`);
  const ext = [];
  for (const c of fixture.ext) {
    const type = typeByExtension(c.ext);
    assert.equal(type, c.type, `TypeByExtension(${c.ext})`);
    if (c.type) {
      const got = [...extensionsByType(c.type)].sort();
      assert.deepEqual(got, [...c.exts].sort(), `ExtensionsByType(${c.type}) via ${c.ext}`);
    }
    ext.push({ ext: c.ext, type, exts: c.type ? [...extensionsByType(c.type)].sort() : [] });
  }
  const before = loadSystemMimeTypes();
  assert.equal(before, 0, 'second unix default load adds no entries after globs2 init');
  for (const c of fixture.ext) {
    assert.equal(typeByExtension(c.ext), c.type, `after default reload ${c.ext}`);
  }
  const packet = { schema: 1, package: 'mime', parse: [], qpEnc: [], qpDec: [], words: [], format: [], headers: [], ext };
  const verified = go(['-verify'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ mime cases/);
  const broken = structuredClone(packet);
  broken.ext[0].type = 'application/x-not-this-type';
  const rejected = go(['-verify'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
});

test('loadSystemMimeTypes custom mime.types matches Go loadMimeFile rules', () => {
  const n = loadSystemMimeTypes([typesFile]);
  assert.ok(n >= 4, `loaded mime.types entries ${n}`);
  assert.equal(typeByExtension('.rustdck6t1'), 'application/x-rustd-mime-ck6-t1');
  assert.equal(typeByExtension('.RUSTDCK6T1'), 'application/x-rustd-mime-ck6-t1');
  assert.equal(typeByExtension('.rustdck6t2'), 'text/x-rustd-mime-ck6-t2; charset=utf-8');
  assert.equal(typeByExtension('.rustdck6a'), 'application/x-rustd-mime-ck6-multi');
  assert.equal(typeByExtension('.rustdck6b'), 'application/x-rustd-mime-ck6-multi');
  assert.equal(typeByExtension('.rustdck6h'), 'application/x-rustd-mime-ck6-hash');
  assert.ok(extensionsByType('application/x-rustd-mime-ck6-t1').includes('.rustdck6t1'));
  assert.ok(extensionsByType('text/x-rustd-mime-ck6-t2').includes('.rustdck6t2'));
  assert.equal(loadSystemMimeTypes(['/no/such/rustd-mime-ck6.types']), 0);
});

test('loadSystemMimeTypes custom globs2 first-weight-wins and ignores globs', () => {
  const n = loadSystemMimeTypes([globsFile]);
  assert.equal(n, 2, `globs2 entries ${n}`);
  assert.equal(typeByExtension('.rustdck6t3'), 'application/x-rustd-mime-ck6-t3');
  assert.equal(typeByExtension('.rustdck6t4'), 'application/x-rustd-mime-ck6-t4');
  assert.equal(typeByExtension(',v'), '');
  assert.equal(typeByExtension('~'), '');
  assert.equal(typeByExtension('.rustdck6foo?ar'), '');
  assert.equal(typeByExtension('.rustdck6foo*r'), '');
  assert.equal(typeByExtension('.rustdck6foo[1-3]'), '');
});
