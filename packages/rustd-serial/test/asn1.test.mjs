import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  asn1Marshal, asn1Unmarshal, Asn1SyntaxError, Asn1StructuralError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/asn1.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', '.', ...args], {
    cwd: resolve(root, 'packages/rustd-serial/gofixtures'),
    encoding: 'utf8',
    input,
    maxBuffer: 32 << 20,
    timeout: 120000,
    env: { ...process.env, GOWORK: 'off' },
  });
  if (result.error) throw result.error;
  return result;
}

function hex(data) {
  return Buffer.from(data).toString('hex');
}

function fromFixtureValue(value) {
  if (Array.isArray(value)) return value.map(fromFixtureValue);
  if (!value || typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, '$b')) {
    return Uint8Array.from(Buffer.from(value.$b, 'hex'));
  }
  if (Object.prototype.hasOwnProperty.call(value, '$i')) return BigInt(value.$i);
  if (Object.prototype.hasOwnProperty.call(value, '$t')) return new Date(value.$t);
  if (Object.prototype.hasOwnProperty.call(value, '$bits')) {
    return { bytes: Uint8Array.from(Buffer.from(value.$bits, 'hex')), bitLength: value.bitLength };
  }
  if (Object.prototype.hasOwnProperty.call(value, '$raw')) {
    const raw = value.$raw;
    return {
      class: raw.class,
      tag: raw.tag,
      isCompound: raw.isCompound,
      bytes: Uint8Array.from(Buffer.from(raw.bytes ?? '', 'hex')),
      fullBytes: Uint8Array.from(Buffer.from(raw.fullBytes ?? '', 'hex')),
    };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = fromFixtureValue(v);
  return out;
}

function assertValue(got, want, id) {
  if (want === null) {
    assert.equal(got, null, id);
    return;
  }
  if (typeof want === 'bigint' || typeof got === 'bigint') {
    assert.equal(got, want, id);
    return;
  }
  if (got instanceof Date || want instanceof Date) {
    assert.equal(got instanceof Date, true, id);
    assert.equal(got.getTime(), want.getTime(), id);
    return;
  }
  if (got instanceof Uint8Array || want instanceof Uint8Array) {
    assert.equal(hex(got), hex(want), id);
    return;
  }
  if (Array.isArray(want)) {
    assert.equal(Array.isArray(got), true, id);
    assert.equal(got.length, want.length, id);
    got.forEach((item, i) => assertValue(item, want[i], `${id}[${i}]`));
    return;
  }
  if (want && typeof want === 'object') {
    assert.equal(got && typeof got === 'object', true, id);
    for (const key of Object.keys(want)) assertValue(got[key], want[key], `${id}.${key}`);
    return;
  }
  assert.equal(got, want, id);
}

test('Go regenerates committed ASN.1 fixtures; native marshal/unmarshal match', () => {
  const generated = go(['-pkg', 'serial-asn1']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go ASN.1 fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'serial-asn1');
  const valid = packet.cases.filter((c) => !c.error && c.id !== 'nest-1000');
  const invalid = packet.cases.filter((c) => c.error && c.id !== 'nest-1000');
  assert.ok(valid.length >= 30, `valid ${valid.length}`);
  assert.ok(invalid.length >= 15, `invalid ${invalid.length}`);

  for (const c of valid) {
    const der = Buffer.from(c.derHex, 'hex');
    const params = c.params || undefined;
    const found = asn1Unmarshal(der, c.schema, params);
    assert.equal(hex(found.rest), c.restHex ?? '', `${c.id} rest`);
    const want = fromFixtureValue(c.value);
    assertValue(found.value, want, c.id);
    if (c.roundTrip) {
      const again = asn1Marshal(found.value, c.schema, params);
      assert.equal(hex(again), hex(der.subarray(0, der.length - found.rest.length)), `${c.id} round-trip`);
    }
  }

  for (const c of invalid) {
    const der = Buffer.from(c.derHex, 'hex');
    assert.throws(() => asn1Unmarshal(der, c.schema, c.params || undefined), (err) => {
      if (c.error === 'syntax') assert.equal(err instanceof Asn1SyntaxError, true, `${c.id} ${err}`);
      else assert.equal(err instanceof Asn1StructuralError, true, `${c.id} ${err}`);
      return true;
    }, c.id);
  }
});

test('JS-generated DER verifies against Go', () => {
  const encodes = [
    { id: 'js-bool', kind: 'bool', derHex: hex(asn1Marshal(true, { kind: 'bool' })) },
    { id: 'js-int', kind: 'int', derHex: hex(asn1Marshal(42, { kind: 'int' })) },
    { id: 'js-oid', kind: 'oid', derHex: hex(asn1Marshal([1, 2, 840, 113549, 1, 1, 1], { kind: 'oid' })) },
    { id: 'js-octets', kind: 'octetstring', derHex: hex(asn1Marshal(Buffer.from('xyz'), { kind: 'octetstring' })) },
    { id: 'js-utf8', kind: 'utf8', derHex: hex(asn1Marshal('café', { kind: 'utf8' })), params: 'utf8' },
    { id: 'js-seqof', kind: 'sequenceof', derHex: hex(asn1Marshal([9, 8, 7], { kind: 'sequenceof', inner: { kind: 'int' } })) },
    { id: 'js-setof', kind: 'setof', derHex: hex(asn1Marshal([3, 1, 2], { kind: 'setof', inner: { kind: 'int' } })) },
    {
      id: 'js-seq-ab',
      kind: 'seq-ab',
      derHex: hex(asn1Marshal({ A: 9, B: 'z' }, {
        kind: 'sequence',
        fields: [{ name: 'A', schema: { kind: 'int' } }, { name: 'B', schema: { kind: 'utf8' } }],
      })),
    },
    {
      id: 'js-seq-explicit',
      kind: 'seq-explicit',
      derHex: hex(asn1Marshal({ A: 5 }, {
        kind: 'sequence',
        fields: [{ name: 'A', schema: { kind: 'explicit', tag: 0, inner: { kind: 'int' } } }],
      })),
    },
    {
      id: 'js-time',
      kind: 'utctime',
      derHex: hex(asn1Marshal(new Date(Date.UTC(2020, 0, 2, 3, 4, 5)), { kind: 'utctime' })),
      params: 'utc',
    },
    { id: 'js-bigint', kind: 'bigint', derHex: hex(asn1Marshal(2n ** 100n, { kind: 'bigint' })) },
    { id: 'js-params-explicit', kind: 'int', derHex: hex(asn1Marshal(4, { kind: 'int' }, 'explicit,tag:2')), params: 'explicit,tag:2' },
  ];
  const verified = go(['-pkg', 'serial-asn1', '-verify'], JSON.stringify({
    schema: 1, package: 'serial-asn1', encodes,
  }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 12 serial-asn1 encode cases/);
});

test('openssl asn1parse reads native DER', () => {
  const der = asn1Marshal({
    A: 1,
    B: 'ok',
    C: Buffer.from('hi'),
  }, {
    kind: 'sequence',
    fields: [
      { name: 'A', schema: { kind: 'int' } },
      { name: 'B', schema: { kind: 'utf8' } },
      { name: 'C', schema: { kind: 'octetstring' } },
    ],
  });
  const parse = spawnSync('openssl', ['asn1parse', '-inform', 'DER'], {
    input: Buffer.from(der),
    encoding: 'utf8',
  });
  assert.equal(parse.status, 0, parse.stderr);
  assert.match(parse.stdout, /SEQUENCE/);
  assert.match(parse.stdout, /INTEGER/);
  assert.match(parse.stdout, /UTF8STRING|OCTET STRING/);
});

test('1000-deep SEQUENCE errors without overflowing; 4GiB length claim is rejected', () => {
  let deep = Buffer.from([0x02, 0x01, 0x00]);
  for (let i = 0; i < 1000; i++) {
    if (deep.length < 128) deep = Buffer.concat([Buffer.from([0x30, deep.length]), deep]);
    else if (deep.length < 256) deep = Buffer.concat([Buffer.from([0x30, 0x81, deep.length]), deep]);
    else deep = Buffer.concat([Buffer.from([0x30, 0x82, deep.length >> 8, deep.length & 0xff]), deep]);
  }
  let schema = { kind: 'int' };
  for (let i = 0; i < 1000; i++) schema = { kind: 'sequence', fields: [{ schema }] };
  assert.throws(() => asn1Unmarshal(deep, schema), (err) => {
    assert.equal(err instanceof Asn1SyntaxError || err instanceof Asn1StructuralError, true);
    return true;
  });
  const huge = Buffer.from([0x04, 0x85, 0x01, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.throws(() => asn1Unmarshal(huge, { kind: 'octetstring' }), Asn1StructuralError);
});

test('params override schema tagging', () => {
  const der = asn1Marshal(7, { kind: 'int' }, 'explicit,tag:1');
  const inner = asn1Marshal(7, { kind: 'int' });
  assert.equal(der[0] & 0xc0, 0x80);
  assert.equal(hex(der.subarray(2)), hex(inner));
  const got = asn1Unmarshal(der, { kind: 'explicit', tag: 9, inner: { kind: 'int' } }, 'explicit,tag:1');
  assert.equal(got.value, 7);
});

test('type errors and slice independence', () => {
  const der = asn1Marshal(1, { kind: 'int' });
  const copy = Buffer.from(der);
  const found = asn1Unmarshal(copy, { kind: 'int' });
  copy[0] = 0xff;
  assert.equal(found.value, 1);
  assert.throws(() => asn1Unmarshal('00', { kind: 'int' }), TypeError);
  assert.throws(() => asn1Marshal(1, { kind: 'int' }, 1), TypeError);
  assert.throws(() => asn1Marshal(1, null), TypeError);
});
