import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  Base64Encoding, Base32Encoding, hexEncode, hexDecode, hexDump,
  ascii85Encode, ascii85Decode, binaryUvarint, binaryAppendVarint, binaryReadUvarint, binaryReadVarint,
  HexLengthError, InvalidByteError, CorruptInputError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', '.', ...args], {
    cwd: resolve(root, 'packages/rustd-encoding/gofixtures'), encoding: 'utf8', input, maxBuffer: 32 << 20,
    env: { ...process.env, GOTOOLCHAIN: 'go1.25.0', GOWORK: 'off' }, timeout: 120000,
  });
  if (result.error) throw result.error;
  return result;
}

const b64 = {
  std: Base64Encoding.Std, url: Base64Encoding.URL, rawstd: Base64Encoding.RawStd, rawurl: Base64Encoding.RawURL,
  'pad-bang': new Base64Encoding('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', { padding: '!' }),
  'strict-std': Base64Encoding.Std.strict(),
};
const b32 = {
  std: Base32Encoding.Std, hex: Base32Encoding.Hex, rawstd: Base32Encoding.RawStd, rawhex: Base32Encoding.RawHex,
  'pad-bang': new Base32Encoding('0123456789abcdefghijklmnopqrstuv', { padding: '!' }),
};

function apply(c) {
  const src = Buffer.from(c.srcHex || '', 'hex');
  switch (c.kind) {
    case 'base64': return Buffer.from(b64[c.name].encodeToString(src), 'ascii').toString('hex');
    case 'base32': return Buffer.from(b32[c.name].encodeToString(src), 'ascii').toString('hex');
    case 'hex': return Buffer.from(hexEncode(src), 'ascii').toString('hex');
    case 'hexdump': return hexDump(src);
    case 'ascii85': return Buffer.from(ascii85Encode(src)).toString('hex');
    case 'uvarint': return Buffer.from(binaryUvarint(BigInt(c.value))).toString('hex');
    case 'varint': return Buffer.from(binaryAppendVarint(new Uint8Array(), BigInt(c.value))).toString('hex');
    default: return null;
  }
}

test('Go 1.25 generates encoding fixtures; native matches', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const packet = JSON.parse(generated.stdout);
  assert.ok(packet.cases.length > 50);
  const hexErrors = packet.cases.filter((c) => c.kind === 'hex-error');
  const ascii85Ws = packet.cases.filter((c) => c.kind === 'ascii85-ws');
  assert.equal(hexErrors.length, 2, 'Go packet must include odd+invalid hex-error cases');
  assert.equal(ascii85Ws.length, 1, 'Go packet must include ascii85-ws wrapper case');
  for (const c of packet.cases) {
    if (c.kind === 'hex-error') {
      const input = Buffer.from(c.srcHex, 'hex').toString('ascii');
      if (c.name === 'odd') {
        assert.throws(() => hexDecode(input), HexLengthError, 'hex-error/odd');
      } else if (c.name === 'invalid') {
        assert.throws(
          () => hexDecode(input),
          (e) => e instanceof InvalidByteError && e.byte === 0x7a,
          'hex-error/invalid',
        );
      } else {
        assert.fail(`unknown hex-error ${c.name}`);
      }
      continue;
    }
    if (c.kind === 'ascii85-ws') {
      const src = Buffer.from(c.srcHex, 'hex');
      const wantIndex = c.error === undefined || c.error === '' ? 2 : Number(c.error);
      assert.throws(
        () => ascii85Decode(src, c.flush === true),
        (e) => e instanceof CorruptInputError && e.byteIndex === wantIndex,
        'ascii85-ws',
      );
      continue;
    }
    if (c.kind === 'hexdump') {
      assert.equal(apply(c), c.dump ?? '', `${c.kind}/${c.name}/${c.srcHex.length}`);
      continue;
    }
    assert.equal(apply(c), c.encHex ?? '', `${c.kind}/${c.name}`);
    if (c.kind === 'base64') {
      const src = Buffer.from(c.srcHex, 'hex');
      assert.deepEqual([...b64[c.name].decode(Buffer.from(c.encHex, 'hex'))], [...src]);
    }
    if (c.kind === 'base32') {
      const src = Buffer.from(c.srcHex, 'hex');
      assert.deepEqual([...b32[c.name].decode(Buffer.from(c.encHex, 'hex'))], [...src]);
    }
    if (c.kind === 'hex') assert.deepEqual([...hexDecode(Buffer.from(c.encHex, 'hex').toString('ascii'))], [...Buffer.from(c.srcHex, 'hex')]);
    if (c.kind === 'ascii85' && c.flush === true) {
      assert.deepEqual([...ascii85Decode(Buffer.from(c.encHex, 'hex'), true)], [...Buffer.from(c.srcHex, 'hex')]);
    }
    if (c.kind === 'uvarint') {
      const encoded = Buffer.from(c.encHex, 'hex');
      const read = binaryReadUvarint(encoded);
      assert.equal(read.value, BigInt(c.value));
      assert.equal(read.n, encoded.length);
    }
    if (c.kind === 'varint') {
      const encoded = Buffer.from(c.encHex, 'hex');
      const read = binaryReadVarint(encoded);
      assert.equal(read.value, BigInt(c.value));
    }
  }
});

test('JS-generated encodings verify in Go', () => {
  const cases = [];
  for (const n of [0, 1, 2, 3, 4, 5, 17, 64]) {
    const src = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 19) & 255);
    const srcHex = Buffer.from(src).toString('hex');
    cases.push({ kind: 'base64', name: 'std', srcHex, encHex: Buffer.from(Base64Encoding.Std.encodeToString(src), 'ascii').toString('hex') });
    cases.push({ kind: 'base32', name: 'std', srcHex, encHex: Buffer.from(Base32Encoding.Std.encodeToString(src), 'ascii').toString('hex') });
    cases.push({ kind: 'hex', name: 'std', srcHex, encHex: Buffer.from(hexEncode(src), 'ascii').toString('hex') });
    cases.push({ kind: 'ascii85', name: `js-${n}`, srcHex, encHex: Buffer.from(ascii85Encode(src)).toString('hex'), flush: true });
  }
  cases.push({ kind: 'hex-error', name: 'odd', srcHex: Buffer.from('abc', 'ascii').toString('hex'), error: 'length' });
  cases.push({ kind: 'hex-error', name: 'invalid', srcHex: Buffer.from('zz', 'ascii').toString('hex'), error: 'byte' });
  cases.push({
    kind: 'ascii85-ws',
    name: 'whitespace-and-wrapper',
    srcHex: Buffer.from(' <~!!!!~> \n\t').toString('hex'),
    encHex: Buffer.from(' <~!!!!~> \n\t').toString('hex'),
    flush: true,
    error: '2',
  });
  const verified = go(['-verify'], JSON.stringify({ version: 1, cases }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ encoding cases/);
  const broken = structuredClone({ version: 1, cases });
  broken.cases[0].encHex = '00';
  assert.notEqual(go(['-verify'], JSON.stringify(broken)).status, 0);
});
