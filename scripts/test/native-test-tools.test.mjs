import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedSpawnSync, goExecutable } from '../native-test-tools.mjs';

test('compiled Go helper executes directly from a path containing spaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustd go helper '));
  try {
    writeFileSync(join(dir, 'main.go'), 'package main\nimport "fmt"\nfunc main() { fmt.Print("helper OK") }\n');
    const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
    const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
    const binary = join(dir, goExecutable('helper'));
    const build = checkedSpawnSync(command, [...prefix, 'build', '-o', binary, 'main.go'], {
      cwd: dir, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(build.status, 0, build.stderr);
    const run = checkedSpawnSync(binary, [], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'helper OK');
    assert.throws(() => checkedSpawnSync(join(dir, 'missing-helper'), []), { code: 'ENOENT' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
