import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
export const root = resolve(import.meta.dirname, '..');
export function packages() {
  return readdirSync(resolve(root, 'packages')).sort().filter(name =>
    existsSync(resolve(root, 'packages', name, 'package.json'))).map(name => {
      const dir = resolve(root, 'packages', name);
      return { dir, manifest: JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) };
    });
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}
if (process.argv[1] === resolve(import.meta.filename)) {
  const action = process.argv[2];
  if (!['build', 'test', 'typecheck'].includes(action)) throw new Error('Expected build, test or typecheck');
  const all = packages();
  if (!all.length) throw new Error('No workspace packages found');
  for (const { dir, manifest } of all) {
    if (!manifest.scripts?.[action]) throw new Error(`${manifest.name} is missing ${action}`);
    run(process.execPath, [process.env.npm_execpath, 'run', action], { cwd: dir });
  }
}
