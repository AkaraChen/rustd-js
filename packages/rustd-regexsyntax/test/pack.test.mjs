import { hostBinaryName } from '../../../scripts/native-test-tools.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

test('host platform .node is present, stripped, and ≤2MB decimal', () => {
  const binary = readdirSync(pkgDir).find((f) => f.endsWith('.node') && f.startsWith(`${manifest.napi.binaryName}.`));
  assert.ok(binary, 'missing platform .node; run pnpm --filter rustd-regexsyntax build');
  const bytes = statSync(join(pkgDir, binary)).size;
  assert.equal(binary, hostBinaryName(manifest.napi.binaryName));
  assert.ok(bytes > 0);
  assert.ok(bytes <= SIZE_CAP, `${binary}: ${bytes} > ${SIZE_CAP}`);
});

test('npm pack CJS+ESM in a clean directory; main tarball has no .node', () => {
  const binary = readdirSync(pkgDir).find((f) => f.endsWith('.node') && f.startsWith(`${manifest.napi.binaryName}.`));
  assert.ok(binary, 'missing platform .node; run pnpm --filter rustd-regexsyntax build');
  const platform = binary.slice(manifest.napi.binaryName.length + 1, -5);
  const temp = mkdtempSync(join(tmpdir(), 'rustd-regexsyntax-pack-'));
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
      const a = require('rustd-regexsyntax');
      if (typeof a.syntaxParse !== 'function') throw new Error('cjs syntaxParse');
      if (typeof a.emptyOpContext !== 'function') throw new Error('cjs emptyOpContext');
      const re = a.syntaxParse('a(b)*c', a.FLAGS.Perl);
      if (re.toString() !== 'a(b)*c' && re.dump().indexOf('lit{a}') < 0) {
        throw new Error('cjs parse: ' + re.dump() + ' ' + re.toString());
      }
      const begin = a.emptyOpContext(-1, 97);
      if ((begin & a.EMPTY_OP.BeginText) !== a.EMPTY_OP.BeginText) throw new Error('cjs emptyOp');
      if (a.isWordChar(97) !== true) throw new Error('cjs isWordChar');
      import('rustd-regexsyntax').then((b) => {
        if (b.FLAGS.Perl !== a.FLAGS.Perl) throw new Error('esm FLAGS');
        const prog = b.syntaxCompile('a+', b.FLAGS.Perl);
        if (!Array.isArray(prog.inst) || prog.inst.length < 1) throw new Error('esm compile');
        if (b.emptyOpContext(-1, 97) !== begin) throw new Error('esm emptyOp');
        console.log('rustd-regexsyntax packed CJS + ESM OK');
      });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { cwd: clean, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /rustd-regexsyntax packed CJS \+ ESM OK/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
