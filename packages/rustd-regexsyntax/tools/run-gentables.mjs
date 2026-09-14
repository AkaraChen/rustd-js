#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const check = process.argv.includes('--check');
const usePathGo = process.env.RUSTD_GO === 'path';
const command = usePathGo ? 'go' : 'mise';
const prefix = usePathGo ? [] : ['exec', 'go@1.24.13', '--', 'go'];
const result = spawnSync(command, [...prefix, 'run', '-C', 'tools/gentables', '.'], {
  env: { ...process.env, GOWORK: 'off' },
  encoding: 'utf8',
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: new URL('..', import.meta.url),
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!check) process.exit(0);

const generated = readFileSync(new URL('../src/unicode_tables.rs', import.meta.url), 'utf8');
if (!generated.includes('go1.24.13')) {
  console.error('src/unicode_tables.rs is missing go1.24.13 pin');
  process.exit(1);
}

const pkg = new URL('..', import.meta.url);
const diff = spawnSync('git', ['diff', '--exit-code', '--', 'src/unicode_tables.rs'], {
  encoding: 'utf8',
  stdio: 'inherit',
  cwd: pkg,
});
if (diff.error) throw diff.error;
process.exit(diff.status ?? 1);
