import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const SIZE_LIMIT = 2_000_000;

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [
    process.env.RUSTD_NPM_CLI ?? resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js'),
    ...args,
  ], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

if (process.platform !== 'win32' && !process.env.RUSTD_NPM_CLI) {
  process.env.RUSTD_NPM_CLI = resolve(process.execPath, '../../lib/node_modules/npm/bin/npm-cli.js');
}

function go(args, opts = {}) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, GOWORK: 'off', CGO_ENABLED: '0' },
    ...opts,
  });
  if (result.error) throw result.error;
  return result;
}

function buildHello() {
  const outDir = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-pack-hello-'));
  const out = join(outDir, 'hello');
  const built = go(['build', '-o', out, '-ldflags', '-w -X main.version=1.2.3', '.'], {
    cwd: join(dir, 'gofixtures'),
  });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  return { outDir, out };
}

test('linux-x64 .node is stripped and under 2MB', () => {
  const binary = readdirSync(dir).find((f) => f.endsWith('.node') && f.startsWith(`${manifest.napi.binaryName}.`));
  assert.ok(binary, 'missing .node; build first');
  const bytes = statSync(join(dir, binary)).size;
  assert.ok(bytes <= SIZE_LIMIT, `${binary}: ${bytes} bytes exceeds ${SIZE_LIMIT}`);
  assert.match(binary, /linux-x64-gnu\.node$/);
});

test('npm pack installs CJS and ESM and parses a linux ELF fixture', () => {
  const binary = readdirSync(dir).find((f) => f.endsWith('.node') && f.startsWith(`${manifest.napi.binaryName}.`));
  assert.ok(binary, 'missing .node; build first');
  const platform = binary.slice(manifest.napi.binaryName.length + 1, -5);
  const { outDir: helloDir, out: hello } = buildHello();
  const temp = mkdtempSync(join(tmpdir(), 'rustd-debugfmt-pack-'));
  try {
    const nativeDir = join(temp, 'native');
    mkdirSync(nativeDir);
    cpSync(join(dir, binary), join(nativeDir, binary));
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
    const mainPack = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], dir))[0];
    assert.equal(mainPack.files.some((f) => f.path.endsWith('.node')), false, 'main tarball must not contain .node');
    const clean = join(temp, 'consumer');
    mkdirSync(clean);
    writeFileSync(join(clean, 'package.json'), '{"private":true}');
    cpSync(hello, join(clean, 'hello'));
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      join(temp, nativePack.filename), join(temp, mainPack.filename)], clean);
    const code = `
      const a = require('rustd-debugfmt');
      import('rustd-debugfmt').then((b) => {
        for (const k of Object.keys(a)) if (a[k] !== b[k]) throw new Error(k + ' differs');
        if (a.sniff(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])) !== 'elf') {
          throw new Error('native sniff failed');
        }
        const file = a.open('hello');
        if (file.kind !== 'elf') throw new Error('kind ' + file.kind);
        if (typeof file.size !== 'bigint') throw new Error('size is not bigint');
        const names = file.symbols().map((s) => s.name);
        if (!names.includes('main.main')) throw new Error('missing main.main');
        const info = file.buildInfo();
        if (!info || !String(info.goVersion).startsWith('go1.')) {
          throw new Error('buildinfo: ' + JSON.stringify(info));
        }
        file.close();
        console.log('rustd-debugfmt packed CJS + ESM OK');
      });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { cwd: clean, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /rustd-debugfmt packed CJS \+ ESM OK/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(helloDir, { recursive: true, force: true });
  }
});
