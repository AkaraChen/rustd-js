import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertStripped } from '../../../scripts/assert-stripped.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const SIZE_CAP = 2_000_000;

function npmCli() {
  if (process.env.RUSTD_NPM_CLI) return process.env.RUSTD_NPM_CLI;
  if (process.platform === 'win32') {
    return resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js');
  }
  const unix = resolve(process.execPath, '../../lib/node_modules/npm/bin/npm-cli.js');
  if (existsSync(unix)) return unix;
  return resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js');
}

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli(), ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function findBinary() {
  return readdirSync(pkgDir).find((f) => f.endsWith('.node') && f.startsWith(`${manifest.napi.binaryName}.`));
}

test('host platform .node is present, stripped, and ≤2MB decimal', () => {
  const binary = findBinary();
  assert.ok(binary, 'missing platform .node; run pnpm --filter rustd-containers build');
  const bytes = statSync(join(pkgDir, binary)).size;
  const suffix = process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : '';
  assert.equal(binary, `rustd-containers.${process.platform}-${process.arch}${suffix}.node`);
  assert.ok(bytes > 0);
  assert.ok(bytes <= SIZE_CAP, `${binary}: ${bytes} > ${SIZE_CAP}`);
  assertStripped(join(pkgDir, binary));
});

test('npm pack CJS+ESM in a clean directory; main tarball has no .node', () => {
  const binary = findBinary();
  assert.ok(binary);
  const platform = binary.slice(manifest.napi.binaryName.length + 1, -5);
  const temp = mkdtempSync(join(tmpdir(), 'rustd-containers-pack-'));
  try {
    const nativeDir = join(temp, 'native');
    mkdirSync(nativeDir);
    cpSync(join(pkgDir, binary), join(nativeDir, binary));
    const [os, cpu] = platform.split('-');
    writeFileSync(join(nativeDir, 'package.json'), JSON.stringify({
      name: `${manifest.name}-${platform}`,
      version: manifest.version,
      main: binary,
      files: [binary],
      os: [os],
      cpu: [cpu],
    }));
    const nativePack = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], nativeDir))[0];
    const mainPack = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], pkgDir))[0];
    assert.ok(!mainPack.files.some((f) => f.path.endsWith('.node')), 'Main tarball must not contain native binaries');
    const clean = join(temp, 'consumer');
    mkdirSync(clean);
    writeFileSync(join(clean, 'package.json'), '{"private":true}');
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, nativePack.filename), join(temp, mainPack.filename)], clean);
    const code = `
      const a = require('rustd-containers');
      const h = new a.Heap((x, y) => x - y, [3, 1, 2]);
      if (h.pop() !== 1) throw new Error('cjs heap');
      const ix = a.SuffixArray.build(new Uint8Array([98, 97, 110, 97, 110, 97]));
      if ([...ix.lookup(new Uint8Array([97, 110]))].join(',') !== '3,1') throw new Error('cjs sa');
      ix.dispose();
      import('rustd-containers').then((b) => {
        const h2 = new b.Heap((x, y) => x - y, [9, 0]);
        if (h2.pop() !== 0) throw new Error('esm heap');
        const list = new b.List();
        list.pushBack('ok');
        if (list.front().value !== 'ok') throw new Error('esm list');
        const ix2 = b.SuffixArray.build(new Uint8Array([98, 97, 110, 97, 110, 97]));
        if ([...ix2.lookup(new Uint8Array([97, 110]))].join(',') !== '3,1') throw new Error('esm sa');
        ix2.dispose();
        console.log('rustd-containers packed CJS + ESM OK');
      });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { cwd: clean, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Packed entrypoints failed: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /packed CJS \+ ESM OK/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('main tarball without native: List/Heap work; SuffixArray is NativeMissingError', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rustd-containers-js-pack-'));
  try {
    const mainPack = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], pkgDir))[0];
    const clean = join(temp, 'consumer');
    mkdirSync(clean);
    writeFileSync(join(clean, 'package.json'), '{"private":true}');
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, mainPack.filename)], clean);
    const code = `
      const a = require('rustd-containers');
      const h = new a.Heap((x, y) => x - y, [3, 1]);
      if (h.pop() !== 1) throw new Error('heap without native');
      const list = new a.List();
      list.pushBack(7);
      if (list.length !== 1) throw new Error('list without native');
      let threw = false;
      try { a.SuffixArray.build(new Uint8Array([1])); } catch (err) {
        threw = true;
        if (err.name !== 'NativeMissingError') throw err;
        if (err.code !== 'ERR_CONTAINERS_NATIVE_MISSING') throw new Error(String(err.code));
      }
      if (!threw) throw new Error('SuffixArray should fail without native');
      console.log('rustd-containers no-native JS OK');
    `;
    const result = spawnSync(process.execPath, ['-e', code], { cwd: clean, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`no-native pack failed: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /no-native JS OK/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
