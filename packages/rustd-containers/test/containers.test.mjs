import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Heap, List, Element, newRing, ringFrom, SuffixArray, SuffixArrayFormatError, SuffixArrayLookupError, NativeMissingError,
} from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));

test('heap empty pop is undefined; remove out of range is RangeError', () => {
  const h = new Heap((a, b) => a - b);
  assert.equal(h.pop(), undefined);
  assert.equal(h.peek(), undefined);
  h.push(2); h.push(1); h.push(3);
  assert.equal(h.peek(), 1);
  assert.equal(h.remove(1), 2);
  assert.throws(() => h.remove(9), RangeError);
  assert.deepEqual([...h].toSorted((a, b) => a - b), [1, 3]);
});

test('list remove of foreign element returns its value and leaves length', () => {
  const l = new List();
  l.pushBack(1);
  const other = new List().pushBack(7);
  assert.equal(l.remove(other), 7);
  assert.equal(l.length, 1);
  assert.deepEqual(l.toArray(), [1]);
  const e = l.front();
  assert.equal(l.remove(e), 1);
  assert.equal(l.length, 0);
  assert.equal(e.next, null);
});

test('list pushBackList copies values (Go semantics); nodes stay on other', () => {
  const a = new List();
  const b = new List();
  const first = b.pushBack('keep');
  a.pushBack(1);
  a.pushBackList(b);
  assert.deepEqual(a.toArray(), [1, 'keep']);
  assert.equal(b.length, 1);
  assert.equal(b.front(), first);
});

test('ring New(0) Do is 0 calls; Unlink(len) length is 3; Move(0) is self', () => {
  const empty = newRing(0);
  let n = 0;
  empty.do(() => { n++; });
  assert.equal(n, 0);
  assert.equal(empty.len(), 0);
  const r = ringFrom(['a', 'b', 'c']);
  assert.equal(r.move(0), r);
  const took = r.unlink(3);
  assert.equal(took.len(), 3);
  assert.equal(r.len(), 3);
});

test('suffixarray rejects bad n, truncated/huge/zero-width payloads, and copies input', () => {
  const src = new Uint8Array([1, 2, 3, 4]);
  const ix = SuffixArray.build(src);
  src[0] = 9;
  assert.deepEqual([...ix.bytes()], [1, 2, 3, 4]);
  assert.throws(() => ix.lookup(new Uint8Array([1]), 1.5), SuffixArrayLookupError);
  assert.throws(() => ix.lookup(new Uint8Array([1]), -2), SuffixArrayLookupError);
  assert.deepEqual([...ix.lookup(new Uint8Array([1]), 0)], []);
  const empty = SuffixArray.build(new Uint8Array());
  assert.equal(empty.length, 0);
  const written = empty.write();
  const restored = SuffixArray.read(written);
  assert.equal(restored.length, 0);
  assert.throws(() => SuffixArray.read(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])), SuffixArrayFormatError);
  assert.throws(() => SuffixArray.read(new Uint8Array(3)), SuffixArrayFormatError);
  const huge = new Uint8Array(10);
  huge[0] = 0xfe; huge[1] = 0xff; huge[2] = 0xff; huge[3] = 0xff; huge[4] = 0xff; huge[5] = 0xff; huge[6] = 0xff; huge[7] = 0xff; huge[8] = 0xff; huge[9] = 0x01;
  assert.throws(() => SuffixArray.read(huge), SuffixArrayFormatError);
  ix.dispose();
  empty.dispose();
  restored.dispose();
});

test('List/Heap work if the native binary is absent; SuffixArray errors clearly', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rustd-containers-js-'));
  try {
    for (const file of ['index.js', 'index.mjs', 'index.d.ts', 'package.json']) {
      cpSync(join(dir, '..', file), join(temp, file));
    }
    const require = createRequire(join(temp, 'index.js'));
    const api = require(join(temp, 'index.js'));
    const h = new api.Heap((a, b) => a - b, [3, 1]);
    assert.equal(h.pop(), 1);
    assert.throws(() => api.SuffixArray.build(new Uint8Array([1])), api.NativeMissingError);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('1 MiB identical bytes build is linear (finishes well under 5s)', () => {
  const data = new Uint8Array(1024 * 1024).fill(97);
  const t0 = performance.now();
  const ix = SuffixArray.build(data);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `build took ${ms}ms`);
  assert.equal(ix.length, data.length);
  ix.dispose();
});
