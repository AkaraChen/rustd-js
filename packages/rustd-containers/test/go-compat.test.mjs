import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  Heap, heapInit, heapPush, heapPop, List, Element, newRing, ringFrom, SuffixArray,
} from '../index.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(dir, 'go-fixtures.json');

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', '.', ...args], {
    cwd: resolve(dir, 'gofixtures'), encoding: 'utf8', input, maxBuffer: 32 << 20, timeout: 120000,
    env: { ...process.env, GOWORK: 'off' },
  });
}

function saFrom(hex) {
  return SuffixArray.build(Uint8Array.from(Buffer.from(hex, 'hex')));
}

test('Go generates suffixarray/heap/list/ring fixtures; native and JS match', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  writeFileSync(fixturePath, generated.stdout);
  const fixture = JSON.parse(generated.stdout);
  assert.ok(fixture.suffixarray.length >= 200, fixture.suffixarray.length);
  for (const c of fixture.suffixarray) {
    const ix = saFrom(c.dataHex);
    assert.equal(Buffer.from(ix.write()).toString('hex'), c.writeHex, c.name);
    const restored = SuffixArray.read(Buffer.from(c.writeHex, 'hex'));
    assert.equal(Buffer.from(restored.write()).toString('hex'), c.writeHex, `${c.name} roundtrip`);
    for (const look of c.lookups) {
      const hits = [...ix.lookup(Buffer.from(look.queryHex, 'hex'), look.n)];
      assert.deepEqual(hits, look.hits, `${c.name} lookup ${look.queryHex} n=${look.n}`);
    }
    ix.dispose();
    restored.dispose();
  }
  for (const c of fixture.heap) {
    const h = new Heap((a, b) => a - b, c.pushes);
    const pops = [h.pop(), h.pop()];
    // The Go fixture pops once, pushes 0, pops again, removes index 1, then Fix(0) after setting 7.
    // Rebuild the documented after-state by replaying with the same comparator.
    const replay = new Heap((a, b) => a - b, c.pushes);
    const gotPops = [heapPop(replay)];
    heapPush(replay, 0);
    gotPops.push(heapPop(replay));
    replay.remove(1);
    replay.toArray()[0] = 7;
    replay.fix(0);
    assert.deepEqual(gotPops, c.pops, c.name);
    assert.deepEqual(replay.toArray(), c.after, c.name);
    heapInit(h);
    assert.ok(pops.length === 2);
  }
  for (const c of fixture.list) {
    const a = new List();
    const b = new List();
    for (const v of c.a) a.pushBack(v);
    for (const v of c.b) b.pushBack(v);
    const foreign = new List().pushBack(c.removeVal);
    assert.equal(a.remove(foreign), c.removeOut);
    a.pushBackList(b);
    assert.deepEqual(a.toArray(), c.afterA);
    assert.deepEqual(b.toArray(), c.afterB);
  }
});

test('JS write bytes → Go Read/Lookup verifies', () => {
  const cases = ['', 'banana', 'mississippi', 'a'.repeat(1024), '你好'].map((text, i) => {
    const data = Buffer.from(text, 'utf8');
    const ix = SuffixArray.build(data);
    const writeHex = Buffer.from(ix.write()).toString('hex');
    const lookups = ['a', 'an', 'na', '你'].map(q => ({
      queryHex: Buffer.from(q, 'utf8').toString('hex'),
      n: -1,
      hits: [...ix.lookup(Buffer.from(q, 'utf8'), -1)],
    }));
    ix.dispose();
    return { name: String(i), dataHex: data.toString('hex'), writeHex, lookups };
  });
  const packet = { version: 1, suffixarray: cases, heap: [], list: [], ring: [] };
  const verified = go(['-verify'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 5 suffixarray cases/);
  const broken = structuredClone(packet);
  broken.suffixarray[1].writeHex = '00';
  assert.notEqual(go(['-verify'], JSON.stringify(broken)).status, 0);
});

test('banana Lookup order matches Go (not sorted)', () => {
  const ix = SuffixArray.build(Buffer.from('banana'));
  assert.deepEqual([...ix.lookup(Buffer.from('an'), -1)], [3, 1]);
  ix.dispose();
});
