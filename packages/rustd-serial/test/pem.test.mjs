import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pemDecode, pemDecodeAll, pemEncode, PemEncodeError } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/pem.json', import.meta.url);

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

function headersEqual(got, want) {
  const a = got ?? {};
  const b = want ?? {};
  assert.deepEqual(a, b);
}

test('Go regenerates committed PEM fixtures; native decode/encode match', () => {
  const generated = go(['-pkg', 'serial-pem']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go PEM fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'serial-pem');
  assert.ok(packet.decodes.length >= 20, `decodes ${packet.decodes.length}`);
  assert.ok(packet.encodes.length >= 6, `encodes ${packet.encodes.length}`);

  for (const c of packet.decodes) {
    const input = Buffer.from(c.inputHex, 'hex');
    const found = pemDecode(input);
    if (!c.found) {
      assert.equal(found, null, c.id);
      continue;
    }
    assert.ok(found, c.id);
    assert.equal(found.block.type, c.type, c.id);
    headersEqual(found.block.headers, c.headers);
    assert.equal(hex(found.block.bytes), c.bytesHex ?? '', `${c.id} bytes`);
    assert.equal(hex(found.rest), c.restHex, `${c.id} rest`);
  }

  for (const c of packet.encodes) {
    const block = {
      type: c.type,
      bytes: Buffer.from(c.bytesHex, 'hex'),
    };
    if (c.headers) block.headers = c.headers;
    if (c.error) {
      assert.throws(() => pemEncode(block), (err) => {
        assert.equal(err instanceof PemEncodeError, true, c.id);
        assert.match(err.message, /colon/);
        return true;
      }, c.id);
      continue;
    }
    assert.equal(hex(pemEncode(block)), c.outputHex, c.id);
  }
});

test('JS-generated PEM bytes verify against Go', () => {
  const empty = pemEncode({ type: 'EMPTY', bytes: new Uint8Array() });
  const hello = pemEncode({ type: 'FOO', bytes: Buffer.from('hello') });
  const hdr = pemEncode({
    type: 'RSA PRIVATE KEY',
    headers: { 'Proc-Type': '4,ENCRYPTED', 'Z-Last': '1', 'A-First': '0' },
    bytes: Buffer.from('abcd'),
  });
  const packet = {
    schema: 1,
    package: 'serial-pem',
    encodes: [
      { id: 'js-empty', type: 'EMPTY', bytesHex: '', outputHex: hex(empty) },
      { id: 'js-hello', type: 'FOO', bytesHex: hex(Buffer.from('hello')), outputHex: hex(hello) },
      {
        id: 'js-headers',
        type: 'RSA PRIVATE KEY',
        headers: { 'Proc-Type': '4,ENCRYPTED', 'Z-Last': '1', 'A-First': '0' },
        bytesHex: hex(Buffer.from('abcd')),
        outputHex: hex(hdr),
      },
    ],
  };
  const verified = go(['-pkg', 'serial-pem', '-verify'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 3 serial-pem encode cases/);
});

test('pemDecodeAll walks concatenated blocks; null when no PEM', () => {
  const a = pemEncode({ type: 'A', bytes: Buffer.from('one') });
  const b = pemEncode({ type: 'B', bytes: Buffer.from('two') });
  const all = pemDecodeAll(Buffer.concat([Buffer.from('noise\n'), a, b]));
  assert.equal(all.length, 2);
  assert.equal(all[0].type, 'A');
  assert.equal(Buffer.from(all[0].bytes).toString(), 'one');
  assert.equal(all[1].type, 'B');
  assert.equal(pemDecodeAll(Buffer.from('nope')).length, 0);
  assert.equal(pemDecode(Buffer.from('nope')), null);
});

test('canonical round-trip Encode(Decode(pem)) matches bytes', () => {
  const canonical = pemEncode({
    type: 'CERTIFICATE',
    bytes: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]),
  });
  const found = pemDecode(canonical);
  assert.equal(hex(pemEncode(found.block)), hex(canonical));
});

test('BEGIN without END and 10k garbage do not hang; rest is original on miss', () => {
  const missing = Buffer.from(`-----BEGIN FOO-----\n${'A'.repeat(1000)}`);
  assert.equal(pemDecode(missing), null);
  const garbage = Buffer.from(`-----BEGIN FOO-----\n${'x'.repeat(10_000)}\n-----END FOO-----\n`);
  const found = pemDecode(garbage);
  if (found) {
    assert.equal(found.block.type, 'FOO');
  }
  const begins = Buffer.from('-----BEGIN \n'.repeat(10_000));
  assert.equal(pemDecode(begins), null);
});

test('openssl reads native PEM certificate DER and a generated key', () => {
  const der = pemDecode(pemEncode({
    type: 'CERTIFICATE',
    bytes: Buffer.from('3003020100', 'hex'),
  })).block.bytes;
  const parse = spawnSync('openssl', ['asn1parse', '-inform', 'DER'], {
    input: Buffer.from(der),
    encoding: 'utf8',
  });
  assert.equal(parse.status, 0, parse.stderr);
  assert.match(parse.stdout, /INTEGER/);

  const generated = spawnSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048'], {
    encoding: 'buffer',
    timeout: 30000,
  });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const decoded = pemDecode(generated.stdout);
  assert.ok(decoded, 'openssl PEM should decode');
  const reencoded = pemEncode(decoded.block);
  const pkey = spawnSync('openssl', ['pkey', '-inform', 'PEM', '-noout', '-text'], {
    input: Buffer.from(reencoded),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(pkey.status, 0, pkey.stderr);
  assert.match(pkey.stdout, /Private-Key|modulus|RSA/i);
});

test('slice independence and type errors', () => {
  const src = Buffer.from(pemEncode({ type: 'FOO', bytes: Buffer.from('hi') }));
  const copy = Buffer.from(src);
  const slice = copy.subarray(0, copy.length);
  const found = pemDecode(slice);
  slice[0] = 90;
  assert.equal(found.block.type, 'FOO');
  assert.equal(src[0], 45);
  found.block.bytes[0] = 1;
  const again = pemDecode(src);
  assert.equal(again.block.bytes[0], Buffer.from('hi')[0]);
  assert.throws(() => pemDecode('-----BEGIN'), TypeError);
  assert.throws(() => pemEncode({ type: 1, bytes: new Uint8Array() }), TypeError);
  assert.throws(() => pemEncode({ type: 'X', headers: { a: 1 }, bytes: new Uint8Array() }), TypeError);
});
