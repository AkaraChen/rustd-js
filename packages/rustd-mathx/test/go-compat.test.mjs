import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as bits from '../index.mjs';

test('JS-generated bit results are accepted by Go math/bits', () => {
  const xs8 = [0, 1, 7, 128, 255];
  const xs16 = [0, 1, 256, 0x8000, 0xffff];
  const xs32 = [0, 1, 0x80000000, 0xffffffff];
  const xs64 = [0n, 1n, 1n << 63n, (1n << 64n) - 1n];
  const ks = [-1, 0, 1, 7, 63, 64];
  const lines = ['package main', 'import ("fmt"; "math/bits"; "os")', 'func main() {'];
  for (const x of xs8) {
    lines.push(`if bits.LeadingZeros8(${x}) != ${bits.leadingZeros8(x)} { os.Exit(1) }`);
    lines.push(`if bits.Reverse8(${x}) != ${bits.reverse8(x)} { os.Exit(1) }`);
    for (const k of ks) lines.push(`if bits.RotateLeft8(${x}, ${k}) != ${bits.rotateLeft8(x, k)} { os.Exit(1) }`);
  }
  for (const x of xs16) {
    lines.push(`if bits.Len16(${x}) != ${bits.len16(x)} { os.Exit(1) }`);
    lines.push(`if bits.ReverseBytes16(${x}) != ${bits.reverseBytes16(x)} { os.Exit(1) }`);
  }
  for (const x of xs32) {
    lines.push(`if bits.OnesCount32(${x}) != ${bits.onesCount32(x)} { os.Exit(1) }`);
    const r = bits.reverse32(x);
    lines.push(`if bits.Reverse32(${x}) != ${r} { os.Exit(1) }`);
  }
  for (const x of xs64) {
    lines.push(`if bits.LeadingZeros64(uint64(${x})) != ${bits.leadingZeros64(x)} { os.Exit(1) }`);
    lines.push(`if bits.Reverse64(uint64(${x})) != uint64(${bits.reverse64(x)}) { os.Exit(1) }`);
    for (const k of ks) {
      lines.push(`if bits.RotateLeft64(uint64(${x}), ${k}) != uint64(${bits.rotateLeft64(x, k)}) { os.Exit(1) }`);
    }
  }
  const a = bits.add64((1n << 64n) - 1n, 1n, 1n);
  lines.push(`{ s, c := bits.Add64(^uint64(0), 1, 1); if s != uint64(${a.sum}) || c != uint64(${a.carryOut}) { os.Exit(1) } }`);
  const m = bits.mul64(0xffffffffffffffffn, 0xffffffffffffffffn);
  lines.push(`{ h, l := bits.Mul64(^uint64(0), ^uint64(0)); if h != uint64(${m.hi}) || l != uint64(${m.lo}) { os.Exit(1) } }`);
  const d = bits.div64(0n, 100n, 7n);
  lines.push(`{ q, r := bits.Div64(0, 100, 7); if q != uint64(${d.quo}) || r != uint64(${d.rem}) { os.Exit(1) } }`);
  lines.push('fmt.Print("Go verified JS math/bits cases") }');
  const temp = mkdtempSync(join(tmpdir(), 'rustd-mathx-'));
  try {
    const file = join(temp, 'verify.go');
    // Include the failed expression: exit status alone cannot distinguish an oracle
    // compiler issue from a native result mismatch on another architecture.
    const diagnosticLines = lines.map(line => line.replaceAll('os.Exit(1)',
      `fmt.Fprintln(os.Stderr, ${JSON.stringify(line)}); os.Exit(1)`));
    writeFileSync(file, diagnosticLines.join('\n'));
    const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
    const args = command === 'go' ? ['run', file] : ['exec', '--', 'go', 'run', file];
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    assert.match(result.stdout, /Go verified JS math\/bits cases/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
