import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const SIZE_LIMIT = 3_000_000;

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

test('linux-x64 .node is stripped and under 3MB', () => {
  const binary = readdirSync(dir).find((f) => f.endsWith('.node') && f.startsWith(`${manifest.napi.binaryName}.`));
  assert.ok(binary, 'missing .node; build first');
  const bytes = statSync(join(dir, binary)).size;
  assert.ok(bytes <= SIZE_LIMIT, `${binary}: ${bytes} bytes exceeds ${SIZE_LIMIT}`);
  assert.match(binary, /linux-x64-gnu\.node$/);
});

test('npm pack installs CJS and ESM with the native binary', () => {
  const binary = readdirSync(dir).find((f) => f.endsWith('.node') && f.startsWith(`${manifest.napi.binaryName}.`));
  assert.ok(binary, 'missing .node; build first');
  const platform = binary.slice(manifest.napi.binaryName.length + 1, -5);
  const temp = mkdtempSync(join(tmpdir(), 'rustd-image-pack-'));
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
    npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      join(temp, nativePack.filename), join(temp, mainPack.filename)], clean);
    const code = `
      const a = require('rustd-image');
      import('rustd-image').then((b) => {
        for (const k of Object.keys(a)) if (a[k] !== b[k]) throw new Error(k + ' differs');
        const img = a.Image.nrgba(a.rect(0, 0, 8, 8));
        img.set(0, 0, a.nrgba({ r: 10, g: 20, b: 30, a: 255 }));
        const encoded = a.pngEncode(img, { compressionLevel: -1 });
        const cfg = a.pngDecodeConfig(encoded);
        if (cfg.width !== 8 || cfg.height !== 8) throw new Error('config ' + JSON.stringify(cfg));
        const dec = a.pngDecode(encoded);
        const px = dec.atRgba(0, 0);
        if ((px.r >> 8) !== 10 || (px.g >> 8) !== 20 || (px.b >> 8) !== 30) {
          throw new Error('native png failed: ' + JSON.stringify(px));
        }
        img.dispose();
        dec.dispose();
        console.log('rustd-image packed CJS + ESM OK');
      });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { cwd: clean, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /rustd-image packed CJS \+ ESM OK/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
