import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packages } from './workspace.mjs';
function npm(args, cwd) {
  // Invoke npm's JS CLI directly to work on Windows without shell quoting.
  const result = spawnSync(process.execPath, [process.env.RUSTD_NPM_CLI ?? resolve(process.execPath, '..', 'node_modules/npm/bin/npm-cli.js'), ...args], { cwd, encoding:'utf8' });
  if (result.error) throw result.error;
  if (result.status) throw new Error(`${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
// Unix Node distributions put npm alongside ../lib/node_modules, Windows alongside node.exe.
if (process.platform !== 'win32' && !process.env.RUSTD_NPM_CLI) {
  process.env.RUSTD_NPM_CLI = resolve(process.execPath, '../../lib/node_modules/npm/bin/npm-cli.js');
}
for (const { dir, manifest } of packages()) {
  const temp = mkdtempSync(join(tmpdir(), 'rustd-pack-'));
  try {
    const binary = readdirSync(dir).find(f => f.endsWith('.node') && f.startsWith(`${manifest.napi.binaryName}.`));
    if (!binary) throw new Error(`${manifest.name}: missing binary`);
    const platform = binary.slice(manifest.napi.binaryName.length + 1, -5);
    const nativeDir = join(temp, 'native'); mkdirSync(nativeDir);
    cpSync(join(dir,binary),join(nativeDir,binary));
    const [os, cpu] = platform.split('-');
    writeFileSync(join(nativeDir,'package.json'),JSON.stringify({name:`${manifest.name}-${platform}`,version:manifest.version,main:binary,files:[binary],os:[os],cpu:[cpu]}));
    const nativePack = JSON.parse(npm(['pack','--json','--pack-destination',temp],nativeDir))[0];
    const mainPack = JSON.parse(npm(['pack','--json','--pack-destination',temp],dir))[0];
    if (mainPack.files.some(f=>f.path.endsWith('.node'))) throw new Error('Main tarball must not contain native binaries');
    const clean = join(temp,'consumer'); mkdirSync(clean);
    writeFileSync(join(clean,'package.json'),'{"private":true}');
    npm(['install','--offline','--ignore-scripts','--no-audit','--no-fund',join(temp,nativePack.filename),join(temp,mainPack.filename)],clean);
    const code = `const a=require(${JSON.stringify(manifest.name)}); import(${JSON.stringify(manifest.name)}).then(b=>{for(const k of Object.keys(a)){if(a[k]!==b[k])throw Error(k+' differs');}if(a.echoBytes && a.echoBytes(new Uint8Array([42]))[0]!==42)throw Error('native call failed'); console.log(${JSON.stringify(manifest.name)}+' packed CJS + ESM OK');})`;
    const result = spawnSync(process.execPath,['-e',code],{cwd:clean,stdio:'inherit'});
    if (result.status !== 0) throw new Error('Packed entrypoints failed');
  } finally { rmSync(temp,{recursive:true,force:true}); }
}
