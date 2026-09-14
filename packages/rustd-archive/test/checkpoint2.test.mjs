import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  tarCreate, tarExtract, zipCreate, zipExtract,
  TarFormatError, ZipFormatError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');

function go(args, input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const prefix = command === 'go' ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', ...args], {
    cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Go exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function everyPrefixThrows(buf, ErrorClass, label) {
  const misses = [];
  for (let n = 1; n < buf.length; n++) {
    try {
      const got = ErrorClass === TarFormatError ? tarExtract(buf.subarray(0, n)) : zipExtract(buf.subarray(0, n));
      misses.push({ n, names: got.map((e) => e.name) });
    } catch (err) {
      assert.ok(err instanceof ErrorClass, `${label} n=${n}: ${err?.name ?? err}`);
    }
  }
  assert.equal(misses.length, 0, `${label} prefixes that did not throw: ${JSON.stringify(misses)}`);
}

test('every tar/zip prefix shorter than the archive is a format error', () => {
  const tar = tarCreate([
    { name: 't', data: new Uint8Array([1, 2, 3, 4]) },
    { name: 'dir/', type: 'dir', mode: 0o755 },
    { name: `${'n'.repeat(120)}.txt`, data: new Uint8Array([9]) },
  ]);
  everyPrefixThrows(tar, TarFormatError, 'tar');

  const zipStore = zipCreate([{ name: 't', method: 0, data: new Uint8Array([1, 2, 3, 4]) }]);
  everyPrefixThrows(zipStore, ZipFormatError, 'zip-store');

  const zipDeflate = zipCreate([
    { name: 'd.txt', method: 8, data: new TextEncoder().encode('deflate payload') },
    { name: 'folder/', method: 0, data: new Uint8Array() },
  ]);
  everyPrefixThrows(zipDeflate, ZipFormatError, 'zip-deflate');
});

test('GNU tar -tf and unzip -l list JS and Go archives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustd-archive-cp2-'));
  try {
    const tar = tarCreate([
      { name: 'a.txt', data: new TextEncoder().encode('aa'), mode: 0o644 },
      { name: 'dir/', type: 'dir', mode: 0o755 },
      { name: 'dir/b.txt', data: new TextEncoder().encode('bee') },
    ]);
    const tarPath = join(dir, 'js.tar');
    writeFileSync(tarPath, tar);
    const tarList = spawnSync('tar', ['-tf', tarPath], { encoding: 'utf8' });
    assert.equal(tarList.status, 0, tarList.stderr);
    const tarNames = tarList.stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(tarNames, ['a.txt', 'dir/', 'dir/b.txt']);

    const zip = zipCreate([
      { name: 's.txt', method: 0, data: new TextEncoder().encode('store') },
      { name: 'd.txt', method: 8, data: new TextEncoder().encode('deflate payload') },
    ]);
    const zipPath = join(dir, 'js.zip');
    writeFileSync(zipPath, zip);
    const zipList = spawnSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf8' });
    assert.equal(zipList.status, 0, zipList.stderr + zipList.stdout);
    const zipNames = zipList.stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(zipNames, ['s.txt', 'd.txt']);

    const packet = JSON.parse(go(['-pkg', 'archive']));
    const tarCase = packet.cases.find((c) => c.kind === 'tar' && (c.entries?.length ?? 0) >= 1);
    const zipCase = packet.cases.find((c) => c.kind === 'zip' && (c.entries?.length ?? 0) >= 1);
    assert.ok(tarCase && zipCase, 'Go archive fixtures missing');

    const goTarPath = join(dir, 'go.tar');
    writeFileSync(goTarPath, Buffer.from(tarCase.archiveHex, 'hex'));
    const goTarList = spawnSync('tar', ['-tf', goTarPath], { encoding: 'utf8' });
    assert.equal(goTarList.status, 0, goTarList.stderr);
    const goTarNames = goTarList.stdout.trim().split('\n').filter(Boolean);
    const wantTar = tarCase.entries.map((e) => e.name).filter((n) => n && n !== '././@PaxHeader');
    for (const name of wantTar) {
      assert.ok(goTarNames.includes(name) || goTarNames.includes(name.replace(/^\.\//, '')), `tar missing ${name} in ${goTarNames}`);
    }

    const goZipPath = join(dir, 'go.zip');
    writeFileSync(goZipPath, Buffer.from(zipCase.archiveHex, 'hex'));
    const goZipList = spawnSync('unzip', ['-Z', '-1', goZipPath], { encoding: 'utf8' });
    assert.equal(goZipList.status, 0, goZipList.stderr + goZipList.stdout);
    const goZipNames = goZipList.stdout.trim().split('\n').filter(Boolean);
    for (const entry of zipCase.entries) {
      assert.ok(goZipNames.includes(entry.name), `zip missing ${entry.name} in ${goZipNames}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
