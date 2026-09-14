import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  canonicalMIMEHeaderKey, mimeHeaderGet, mimeHeaderValues, mimeHeaderSet, mimeHeaderAdd, mimeHeaderDel,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/mime', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20,
    env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 120000,
  });
}

function sortedRecord(rec) {
  return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
}

test('canonicalMIMEHeaderKey matches Go textproto.CanonicalMIMEHeaderKey table', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const fixture = JSON.parse(generated.stdout);
  assert.ok(fixture.canon.length >= 20, `canon cases ${fixture.canon.length}`);
  for (const c of fixture.canon) {
    assert.equal(canonicalMIMEHeaderKey(c.in), c.out, JSON.stringify(c.in));
  }
});

test('MIMEHeader Get/Set/Add/Del/Values fold keys like Go textproto.MIMEHeader', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const fixture = JSON.parse(generated.stdout);
  assert.ok(fixture.mimeHeader.length >= 8, `mimeHeader cases ${fixture.mimeHeader.length}`);
  for (const c of fixture.mimeHeader) {
    const header = {};
    for (const op of c.ops ?? []) {
      if (op.op === 'add') mimeHeaderAdd(header, op.key, op.value);
      else if (op.op === 'set') mimeHeaderSet(header, op.key, op.value);
      else if (op.op === 'del') mimeHeaderDel(header, op.key);
      else assert.fail(`unknown op ${op.op}`);
    }
    for (const [key, want] of Object.entries(c.gets)) {
      assert.equal(mimeHeaderGet(header, key), want, `${c.id} get ${key}`);
    }
    for (const [key, want] of Object.entries(c.values)) {
      assert.deepEqual(mimeHeaderValues(header, key), want ?? [], `${c.id} values ${key}`);
    }
    assert.deepEqual(sortedRecord(header), sortedRecord(c.record), `${c.id} record`);
  }
});

test('nil MIMEHeader Get/Values match Go (empty, no throw)', () => {
  assert.equal(mimeHeaderGet(null, 'Content-Type'), '');
  assert.equal(mimeHeaderGet(undefined, 'Content-Type'), '');
  assert.deepEqual(mimeHeaderValues(null, 'Content-Type'), []);
});

test('MIMEHeader is a plain Record with canonical keys (issue #9 Part.header)', () => {
  const header = {};
  mimeHeaderAdd(header, 'content-type', 'text/plain');
  mimeHeaderAdd(header, 'Content-Type', 'text/html');
  mimeHeaderAdd(header, 'X-Custom', 'a');
  assert.deepEqual(Object.keys(header).sort(), ['Content-Type', 'X-Custom']);
  assert.deepEqual(header['Content-Type'], ['text/plain', 'text/html']);
  assert.equal(header['content-type'], undefined);
});

test('native MIMEHeader outputs verify against Go textproto', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const fixture = JSON.parse(generated.stdout);
  const canon = fixture.canon.map((c) => ({ in: c.in, out: canonicalMIMEHeaderKey(c.in) }));
  const mimeHeader = fixture.mimeHeader.map((c) => {
    const header = {};
    for (const op of c.ops ?? []) {
      if (op.op === 'add') mimeHeaderAdd(header, op.key, op.value);
      else if (op.op === 'set') mimeHeaderSet(header, op.key, op.value);
      else if (op.op === 'del') mimeHeaderDel(header, op.key);
    }
    const gets = {};
    for (const key of Object.keys(c.gets)) gets[key] = mimeHeaderGet(header, key);
    const values = {};
    for (const key of Object.keys(c.values)) values[key] = mimeHeaderValues(header, key);
    return { id: c.id, ops: c.ops, gets, values, record: header };
  });
  const packet = { ...fixture, canon, mimeHeader };
  const verified = go(['-verify'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ mime cases/);
});
