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
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!check) process.exit(0);

const generated = readFileSync('src/generated.rs', 'utf8');
if (!generated.includes('go1.24.13')) {
  console.error('src/generated.rs is missing go1.24.13 pin');
  process.exit(1);
}

const diff = spawnSync('git', ['diff', '--exit-code', '--', 'src/generated.rs', 'generated-names.d.ts', 'test/fixtures'], {
  encoding: 'utf8',
  stdio: 'inherit',
});
if (diff.error) throw diff.error;
process.exit(diff.status ?? 1);
