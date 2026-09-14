import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  gobEncode, gobDecode, gobRegisterName, GobEncoder, GobDecoder, GobTypeError, BufferTooShortError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
function go(args = [], input, cwd = resolve(root, 'packages/rustd-encoding/gobfix')) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', '.', ...args], {
    cwd, encoding: 'utf8', input, maxBuffer: 32 << 20,
    env: { ...process.env, GOTOOLCHAIN: 'go1.25.0', GOWORK: 'off' }, timeout: 120000,
  });
  if (result.error) throw result.error;
  return result;
}

const Point = { kind: 'struct', name: 'Point', fields: [
  { name: 'X', type: { kind: 'int' } }, { name: 'Y', type: { kind: 'int' } },
]};
const Inner = { kind: 'struct', name: 'Inner', fields: [{ name: 'N', type: { kind: 'int' } }] };
const Outer = { kind: 'struct', name: 'Outer', fields: [{ name: 'I', type: Inner }] };
const Person = { kind: 'struct', name: 'Person', fields: [
  { name: 'Name', type: { kind: 'string' } },
  { name: 'Age', type: { kind: 'int' } },
  { name: 'Note', type: { kind: 'string' } },
]};
const Holder = { kind: 'struct', name: 'Holder', fields: [{ name: 'V', type: { kind: 'interface' } }] };

function tsEncode(name) {
  gobRegisterName('main.Point', Point);
  switch (name) {
    case 'int3': return gobEncode(3, { kind: 'int' });
    case 'boolT': return gobEncode(true, { kind: 'bool' });
    case 'str': return gobEncode('hi', { kind: 'string' });
    case 'bytes': return gobEncode(Uint8Array.from([1, 2, 3]), { kind: 'bytes' });
    case 'point': return gobEncode({ X: 22, Y: 33 }, Point);
    case 'outer': return gobEncode({ I: { N: 7 } }, Outer);
    case 'slice': return gobEncode([1, 2, 3], { kind: 'slice', elem: { kind: 'int' } });
    case 'arr': return gobEncode([4, 5], { kind: 'array', elem: { kind: 'int' }, len: 2 });
    case 'person': return gobEncode({ Name: 'x', Age: 0, Note: 'y' }, Person);
    case 'emptySlice': return gobEncode([], { kind: 'slice', elem: { kind: 'int' } });
    case 'nilSlice': return gobEncode(null, { kind: 'slice', elem: { kind: 'int' } });
    case 'emptyMap': return gobEncode(new Map(), { kind: 'map', key: { kind: 'string' }, elem: { kind: 'int' } });
    case 'nilMap': return gobEncode(null, { kind: 'map', key: { kind: 'string' }, elem: { kind: 'int' } });
    case 'float': return gobEncode(1, { kind: 'float64' });
    case 'int64': return gobEncode(1n << 62n, { kind: 'int64' });
    case 'uint': return gobEncode(128n, { kind: 'uint64' });
    case 'holder': return gobEncode({ V: { $name: 'main.Point', $type: Point, $value: { X: 22, Y: 33 } } }, Holder);
    case 'iface': return gobEncode({ $name: 'main.Point', $type: Point, $value: { X: 22, Y: 33 } }, { kind: 'interface' });
    default: throw new Error(name);
  }
}

function tsType(name) {
  switch (name) {
    case 'int3': return { kind: 'int' };
    case 'boolT': return { kind: 'bool' };
    case 'str': return { kind: 'string' };
    case 'bytes': return { kind: 'bytes' };
    case 'point': return Point;
    case 'outer': return Outer;
    case 'slice': case 'emptySlice': case 'nilSlice': return { kind: 'slice', elem: { kind: 'int' } };
    case 'arr': return { kind: 'array', elem: { kind: 'int' }, len: 2 };
    case 'person': return Person;
    case 'emptyMap': case 'nilMap': return { kind: 'map', key: { kind: 'string' }, elem: { kind: 'int' } };
    case 'float': return { kind: 'float64' };
    case 'int64': return { kind: 'int64' };
    case 'uint': return { kind: 'uint64' };
    case 'holder': return Holder;
    case 'iface': return { kind: 'interface' };
    default: throw new Error(name);
  }
}

test('Go fixtures match TS bytes; TS reads Go streams', () => {
  gobRegisterName('main.Point', Point);
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const packet = JSON.parse(generated.stdout);
  assert.ok(packet.cases.length >= 16);
  for (const c of packet.cases) {
    const ts = Buffer.from(tsEncode(c.name));
    if (c.name !== 'emptyMap' && c.name !== 'nilMap') {
      assert.equal(ts.toString('hex'), c.encHex, c.name);
    }
    const goBytes = Buffer.from(c.encHex, 'hex');
    const decoded = gobDecode(goBytes, tsType(c.name));
    if (c.name === 'point') assert.deepEqual(decoded, { X: 22, Y: 33 });
    if (c.name === 'int3') assert.equal(decoded, 3);
    if (c.name === 'int64') assert.equal(decoded, 1n << 62n);
    if (c.name === 'person') assert.equal(decoded.Age, 0);
  }
});

test('TS encodings decode in Go', () => {
  gobRegisterName('main.Point', Point);
  const cases = [
    'int3', 'boolT', 'str', 'bytes', 'point', 'outer', 'slice', 'arr', 'person',
    'emptySlice', 'nilSlice', 'emptyMap', 'nilMap', 'float', 'int64', 'uint', 'holder', 'iface',
  ].map((name) => ({ name, encHex: Buffer.from(tsEncode(name)).toString('hex') }));
  const verified = go(['-verify'], JSON.stringify({ version: 1, cases }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ gob cases/);
});

test('gob encoder streams, decoder write, maxTypeSize, and errors', () => {
  gobRegisterName('main.Point', Point);
  const chunks = [];
  const enc = new GobEncoder({ onChunk: (c) => chunks.push(c) });
  enc.encode({ X: 1, Y: 2 }, Point);
  enc.encode({ X: 3, Y: 4 }, Point);
  const all = enc.finish();
  assert.ok(chunks.length >= 1);
  const dec = new GobDecoder();
  dec.write(all.subarray(0, 4));
  dec.write(all.subarray(4));
  assert.deepEqual(dec.decode(Point), { X: 1, Y: 2 });
  assert.deepEqual(dec.decode(Point), { X: 3, Y: 4 });
  const tiny = new GobDecoder({ maxTypeSize: 8 });
  tiny.write(gobEncode({ X: 22, Y: 33 }, Point));
  assert.throws(() => tiny.decode(Point), GobTypeError);
  const trunc = new GobDecoder();
  trunc.write(gobEncode(3, { kind: 'int' }).subarray(0, 1));
  assert.throws(() => trunc.decode({ kind: 'int' }), BufferTooShortError);
  assert.throws(() => gobEncode({ $name: 'nope', $type: Point, $value: { X: 1, Y: 1 } }, { kind: 'interface' }), GobTypeError);
});

test('every truncated gob prefix fails; Go agrees; type mismatches error', () => {
  gobRegisterName('main.Point', Point);
  const names = [
    'int3', 'boolT', 'str', 'bytes', 'point', 'outer', 'slice', 'arr', 'person',
    'emptySlice', 'float', 'int64', 'uint',
  ];
  let prefixes = 0;
  for (const name of names) {
    const full = tsEncode(name);
    const ty = tsType(name);
    assert.doesNotThrow(() => gobDecode(full, ty), name);
    for (let i = 0; i < full.length; i++) {
      const dec = new GobDecoder();
      dec.write(full.subarray(0, i));
      assert.throws(
        () => dec.decode(ty),
        (e) => e instanceof BufferTooShortError,
        `${name} prefix ${i}/${full.length}`,
      );
      prefixes++;
    }
  }
  assert.ok(prefixes >= 80, `expected many prefixes, got ${prefixes}`);

  const generated = go(['-trunc']);
  assert.equal(generated.status, 0, generated.stderr);
  const packet = JSON.parse(generated.stdout);
  assert.equal(packet.cases.length, names.length);
  for (const c of packet.cases) {
    assert.equal(c.failedPrefixes, c.len, c.name);
    assert.equal(c.len, tsEncode(c.name).length, c.name);
  }

  const intStream = tsEncode('int3');
  assert.throws(() => gobDecode(intStream, { kind: 'string' }), GobTypeError);
  assert.throws(() => gobDecode(intStream, Point), GobTypeError);
  const pointStream = tsEncode('point');
  assert.throws(() => gobDecode(pointStream, { kind: 'int' }), GobTypeError);
  assert.throws(
    () => gobEncode({ $name: 'main.Unregistered', $type: Point, $value: { X: 1, Y: 1 } }, { kind: 'interface' }),
    GobTypeError,
  );

  const huge = new Uint8Array([0xfa, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const capped = new GobDecoder({ maxTypeSize: 64 });
  capped.write(huge);
  assert.throws(() => capped.decode({ kind: 'int' }), GobTypeError);
});
