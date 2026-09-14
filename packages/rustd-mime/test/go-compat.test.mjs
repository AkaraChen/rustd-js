import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  parseMediaType, formatMediaType, typeByExtension, extensionsByType,
  quotedPrintableEncode, quotedPrintableDecode, QuotedPrintableError, QuotedPrintableReader,
  encodeWord, MimeWordDecoder, InvalidMediaParameterError, MediaTypeError,
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

function parseNative(input) {
  try {
    const { mediaType, params } = parseMediaType(input);
    return { mediaType, params, error: '' };
  } catch (err) {
    if (err instanceof InvalidMediaParameterError) {
      return { mediaType: err.mediaType, params: err.params, error: err.message };
    }
    if (err instanceof MediaTypeError) {
      return { mediaType: '', params: {}, error: err.message };
    }
    throw err;
  }
}

test('Go generates media-type, quoted-printable, RFC 2047 and extension fixtures; native matches', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const fixture = JSON.parse(generated.stdout);
  assert.equal(fixture.package, 'mime');
  assert.ok(fixture.parse.length >= 200, `parse cases ${fixture.parse.length}`);
  for (const c of fixture.parse) {
    const got = parseNative(c.in);
    assert.equal(got.mediaType, c.mediaType, `mediaType ${c.in}`);
    assert.equal(got.error, c.error, `error ${c.in}`);
    assert.deepEqual(got.params, c.params ?? {}, `params ${c.in}`);
    if (!c.error && Object.keys(c.params ?? {}).length) {
      const formatted = formatMediaType(c.mediaType, c.params);
      const round = parseNative(formatted);
      assert.equal(round.mediaType, c.mediaType, `roundtrip ${c.in}`);
    }
  }
  for (const c of fixture.qpEnc) {
    const encoded = quotedPrintableEncode(Buffer.from(c.inHex, 'hex'), { binary: c.binary });
    assert.equal(Buffer.from(encoded).toString('hex'), c.outHex, c.id);
  }
  for (const c of fixture.qpDec) {
    try {
      const decoded = quotedPrintableDecode(Buffer.from(c.inHex, 'hex'));
      assert.equal(c.error, '', `expected error for ${c.id}: ${c.error}`);
      assert.equal(Buffer.from(decoded).toString('hex'), c.outHex, c.id);
      const reader = new QuotedPrintableReader(Buffer.from(c.inHex, 'hex'));
      const chunks = [];
      for (;;) {
        const piece = reader.read(1);
        if (piece.length === 0) break;
        chunks.push(Buffer.from(piece));
      }
      assert.equal(Buffer.concat(chunks).toString('hex'), c.outHex, `1-byte ${c.id}`);
    } catch (err) {
      assert.ok(err instanceof QuotedPrintableError, c.id);
      assert.equal(err.message, c.error, c.id);
      if (err.decoded) assert.equal(Buffer.from(err.decoded).toString('hex'), c.outHex, `${c.id} partial`);
    }
  }
  const decoder = new MimeWordDecoder();
  for (const c of fixture.words) {
    assert.equal(encodeWord(c.charset, c.src, c.enc), c.encoded, `encode ${c.src}`);
    assert.equal(decoder.decodeHeader(c.encoded), c.decoded, `decode ${c.src}`);
    if (c.header) assert.equal(decoder.decodeHeader(c.header), c.headerOut, `header ${c.src}`);
  }
  for (const c of fixture.ext) {
    assert.equal(typeByExtension(c.ext), c.type, `ext ${c.ext}`);
    if (c.type) {
      const got = extensionsByType(c.type);
      assert.deepEqual([...got].sort(), [...c.exts].sort(), `exts ${c.ext}`);
    }
  }
});

test('JS generates quoted-printable and media types → Go verifies', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const fixture = JSON.parse(generated.stdout);
  const parse = fixture.parse.map((c) => ({ in: c.in, ...parseNative(c.in) }));
  const qpEnc = [0, 1, 17, 75, 76, 200].map((length, i) => {
    const data = Uint8Array.from({ length }, (_, j) => (j * 31 + i) & 255);
    const encoded = quotedPrintableEncode(data, { binary: true });
    return { id: `js-${length}`, inHex: Buffer.from(data).toString('hex'), outHex: Buffer.from(encoded).toString('hex'), binary: true, mode: 'encode', error: '' };
  });
  const packet = { schema: 1, package: 'mime', parse, qpEnc, qpDec: [], words: [] };
  const verified = go(['-verify'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ mime cases/);
  const broken = structuredClone(packet);
  broken.qpEnc[0].outHex = '00';
  const rejected = go(['-verify'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
});
