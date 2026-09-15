import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newPCG, newChaCha8 } from '../index.mjs';

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function goRun(src) {
  const temp = mkdtempSync(join(tmpdir(), 'rustd-mathx-js2go-'));
  try {
    const file = join(temp, 'verify.go');
    writeFileSync(file, src);
    const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
    const args = command === 'go' ? ['run', file] : ['exec', '--', 'go', 'run', file];
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `go exit ${result.status}`);
    }
    return result.stdout.trim();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function goContinue(kind, stateHex, n) {
  const construct = kind === 'pcg'
    ? `src := rand.NewPCG(0, 0)
	if err := src.UnmarshalBinary(b); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
	r := rand.New(src)`
    : `var seed [32]byte
	src := rand.NewChaCha8(seed)
	if err := src.UnmarshalBinary(b); err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
	r := rand.New(src)`;
  const src = `package main
import (
	"encoding/hex"
	"fmt"
	"math/rand/v2"
	"os"
)
func main() {
	b, err := hex.DecodeString("${stateHex}")
	if err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
	${construct}
	for i := 0; i < ${n}; i++ {
		if i > 0 { fmt.Print(",") }
		fmt.Print(r.Uint64())
	}
}
`;
  return goRun(src).split(',').map((s) => BigInt(s));
}

function stream(kind, rng, drawsBefore) {
  for (let i = 0; i < drawsBefore; i++) rng.uint64();
  const state = rng.state();
  const next = [];
  for (let i = 0; i < 8; i++) next.push(rng.uint64());
  const fromGo = goContinue(kind, hex(state), 8);
  assert.deepEqual(fromGo, next, `${kind} after ${drawsBefore} draws: Go UnmarshalBinary stream`);
}

test('JS PCG state() UnmarshalBinary in Go continues the stream (issue #21 §4.4b)', () => {
  stream('pcg', newPCG(1n, 2n), 0);
  stream('pcg', newPCG(1n, 2n), 100);
  stream('pcg', newPCG(0n, 0n), 17);
});

test('JS ChaCha8 state() UnmarshalBinary in Go continues the stream (issue #21 §4.4b)', () => {
  const seed = new Uint8Array(32);
  seed[0] = 1;
  stream('chacha8', newChaCha8(seed), 0);
  stream('chacha8', newChaCha8(seed), 100);
  const other = new Uint8Array(32);
  other[31] = 7;
  stream('chacha8', newChaCha8(other), 3);
});
