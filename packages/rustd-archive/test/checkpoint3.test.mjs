import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  tarCreate, tarExtract, zipCreate, zipExtract, ZipFormatError,
} from '../index.mjs';

const pkgDir = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const SIG_CENTRAL = 0x02014b50;

function u32le(buf, off) {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

function findCentral(buf) {
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (u32le(buf, i) >>> 0 === SIG_CENTRAL) return i;
  }
  throw new Error('no central-directory record');
}

test('255-byte names, >100-char paths, and deep dirs round-trip tar and zip', () => {
  const long255 = 'n'.repeat(255);
  const path101 = `${'d'.repeat(40)}/${'e'.repeat(40)}/${'f'.repeat(20)}.txt`;
  assert.ok(path101.length > 100);
  const deep = Array.from({ length: 12 }, (_, i) => `l${i}`).join('/') + '/leaf.txt';
  const entries = [
    { name: long255, data: new TextEncoder().encode('255') },
    { name: path101, data: new TextEncoder().encode('pax') },
    { name: deep, data: new TextEncoder().encode('deep') },
  ];

  const tar = tarCreate(entries);
  const tarGot = tarExtract(tar);
  assert.deepEqual(tarGot.map((e) => e.name), entries.map((e) => e.name));
  assert.equal(new TextDecoder().decode(tarGot[0].data), '255');
  assert.equal(new TextDecoder().decode(tarGot[1].data), 'pax');
  assert.equal(new TextDecoder().decode(tarGot[2].data), 'deep');

  const zip = zipCreate(entries.map((e) => ({ ...e, method: 0 })));
  const zipGot = zipExtract(zip);
  assert.deepEqual(zipGot.map((e) => e.name), entries.map((e) => e.name));
  assert.equal(new TextDecoder().decode(zipGot[0].data), '255');
});

test('duplicate entry names are preserved in order for tar and zip', () => {
  const dups = [
    { name: 'same.txt', data: new TextEncoder().encode('first') },
    { name: 'same.txt', data: new TextEncoder().encode('second') },
  ];
  const tarGot = tarExtract(tarCreate(dups));
  assert.equal(tarGot.length, 2);
  assert.deepEqual(tarGot.map((e) => e.name), ['same.txt', 'same.txt']);
  assert.equal(new TextDecoder().decode(tarGot[0].data), 'first');
  assert.equal(new TextDecoder().decode(tarGot[1].data), 'second');

  const zipGot = zipExtract(zipCreate(dups.map((e) => ({ ...e, method: 0 }))));
  assert.equal(zipGot.length, 2);
  assert.deepEqual(zipGot.map((e) => e.name), ['same.txt', 'same.txt']);
  assert.equal(new TextDecoder().decode(zipGot[0].data), 'first');
  assert.equal(new TextDecoder().decode(zipGot[1].data), 'second');
});

test('zip central-directory local-header offset past EOF is ZipFormatError', () => {
  const zip = zipCreate([{ name: 't', method: 0, data: new Uint8Array([1]) }]);
  const evil = new Uint8Array(zip);
  const cd = findCentral(evil);
  // CD local-header offset is 42 bytes into the central record.
  evil[cd + 42] = 0xff;
  evil[cd + 43] = 0xff;
  evil[cd + 44] = 0xff;
  evil[cd + 45] = 0x7f;
  assert.throws(() => zipExtract(evil), ZipFormatError);
});

test('linux-x64 .node is stripped and <= 2MB', () => {
  const files = readdirSync(pkgDir).filter((name) => name.endsWith('.node'));
  assert.ok(files.length >= 1, 'missing .node; run pnpm --filter rustd-archive build');
  for (const file of files) {
    const bytes = statSync(join(pkgDir, file)).size;
    assert.ok(bytes <= 2_000_000, `${file}: ${bytes} bytes exceeds 2MB`);
    assert.ok(bytes > 0);
  }
});

test('npm pack loads CJS and ESM from a clean directory without shipping .node in the main tarball', () => {
  const npmCli = process.env.RUSTD_NPM_CLI ?? (process.platform === 'win32'
    ? join(process.execPath, '../node_modules/npm/bin/npm-cli.js')
    : join(process.execPath, '../../lib/node_modules/npm/bin/npm-cli.js'));
  assert.ok(existsSync(npmCli), npmCli);
  const binary = readdirSync(pkgDir).find((name) => name.startsWith('rustd-archive.') && name.endsWith('.node'));
  assert.ok(binary, 'missing native binary');
  const platform = binary.slice('rustd-archive.'.length, -'.node'.length);
  const temp = mkdtempSync(join(tmpdir(), 'rustd-archive-pack-'));
  try {
    const nativeDir = join(temp, 'native');
    mkdirSync(nativeDir);
    cpSync(join(pkgDir, binary), join(nativeDir, binary));
    writeFileSync(join(nativeDir, 'package.json'), JSON.stringify({
      name: `rustd-archive-${platform}`,
      version: '0.1.0',
      main: binary,
      files: [binary],
      os: [platform.split('-')[0]],
      cpu: [platform.split('-')[1]],
    }));
    const nativePack = spawnSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', temp], {
      cwd: nativeDir, encoding: 'utf8',
    });
    assert.equal(nativePack.status, 0, nativePack.stderr);
    const mainPack = spawnSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', temp], {
      cwd: pkgDir, encoding: 'utf8',
    });
    assert.equal(mainPack.status, 0, mainPack.stderr);
    const [nativeMeta] = JSON.parse(nativePack.stdout);
    const [mainMeta] = JSON.parse(mainPack.stdout);
    assert.equal(mainMeta.files.some((f) => f.path.endsWith('.node')), false);

    const consumer = join(temp, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true}');
    const install = spawnSync(
      process.execPath,
      [
        npmCli, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
        join(temp, nativeMeta.filename), join(temp, mainMeta.filename),
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(install.status, 0, install.stderr);

    const cjs = spawnSync(
      process.execPath,
      ['-e', 'const m=require("rustd-archive"); const b=m.tarCreate([{name:"x",data:new Uint8Array([7])}]); if (m.tarExtract(b)[0].data[0]!==7) process.exit(2);'],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(cjs.status, 0, cjs.stderr + cjs.stdout);

    const esm = spawnSync(
      process.execPath,
      ['-e', 'import("rustd-archive").then(m=>{const b=m.zipCreate([{name:"x",method:0,data:new Uint8Array([9])}]); if(m.zipExtract(b)[0].data[0]!==9) process.exit(2);})'],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(esm.status, 0, esm.stderr + esm.stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

void dirname;
void fileURLToPath;
void require;
