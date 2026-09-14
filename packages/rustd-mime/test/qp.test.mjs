import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  quotedPrintableEncode, quotedPrintableDecode, QuotedPrintableReader,
  QuotedPrintableWriter, QuotedPrintableError,
} from '../index.mjs';

test('quoted-printable reader matches Go lax cases and 1-byte feeding', () => {
  const cases = [
    ['foo bar=3D', 'foo bar='],
    ['foo bar=\n', 'foo bar'],
    ['foo=\r\nbar', 'foobar'],
    [' A B        \r\n C ', ' A B\r\n C'],
  ];
  for (const [input, want] of cases) {
    const all = Buffer.from(quotedPrintableDecode(Buffer.from(input)));
    assert.equal(all.toString(), want, input);
    const reader = new QuotedPrintableReader(Buffer.from(input));
    const chunks = [];
    for (;;) {
      const piece = reader.read(1);
      if (piece.length === 0) break;
      chunks.push(Buffer.from(piece));
    }
    assert.equal(Buffer.concat(chunks).toString(), want, `1-byte ${input}`);
  }
});

test('quoted-printable writer binary switch changes CR/LF encoding', () => {
  const data = Buffer.from('foo bar\r\n');
  const text = Buffer.from(quotedPrintableEncode(data, { binary: false })).toString();
  const bin = Buffer.from(quotedPrintableEncode(data, { binary: true })).toString();
  assert.equal(text, 'foo bar\r\n');
  assert.equal(bin, 'foo bar=0D=0A');
  const writer = new QuotedPrintableWriter({ binary: true });
  writer.write(data);
  assert.equal(Buffer.from(writer.finish()).toString(), bin);
});

test('quoted-printable rejects NUL and exposes partial decoded bytes', () => {
  assert.throws(() => quotedPrintableDecode(Buffer.from('foo\x00bar')), QuotedPrintableError);
  try {
    quotedPrintableDecode(Buffer.from('foo\x00bar'));
  } catch (err) {
    assert.equal(Buffer.from(err.decoded).toString(), 'foo');
  }
});

function pythonQuopri(mode, input) {
  const code = mode === 'encode'
    ? 'import sys,quopri; sys.stdout.buffer.write(quopri.encodestring(sys.stdin.buffer.read()))'
    : 'import sys,quopri; sys.stdout.buffer.write(quopri.decodestring(sys.stdin.buffer.read()))';
  const py = spawnSync('python3', ['-c', code], {
    input, timeout: 10000, maxBuffer: 16 << 20,
  });
  assert.equal(py.status, 0, String(py.stderr ?? ''));
  return Buffer.from(py.stdout);
}

test('python3 quopri encode/decode round-trips with quotedPrintable*', () => {
  const samples = [
    Buffer.from("Now's the time for all folk to come to the aid of their country."),
    Buffer.from('hello=world'),
    Buffer.from('trailing space '),
    Buffer.from('tab\there'),
    Buffer.from('foo bar\r\n'),
    Buffer.from('A'.repeat(80)),
    Buffer.from('x'.repeat(200)),
    Buffer.from({ length: 256 }, (_, i) => i),
  ];
  for (const payload of samples) {
    const pyEncoded = pythonQuopri('encode', payload);
    assert.deepEqual(Buffer.from(quotedPrintableDecode(pyEncoded)), payload, `py encode → native decode ${payload.length}`);
    const reader = new QuotedPrintableReader(pyEncoded);
    const chunks = [];
    for (;;) {
      const piece = reader.read(1);
      if (piece.length === 0) break;
      chunks.push(Buffer.from(piece));
    }
    assert.deepEqual(Buffer.concat(chunks), payload, `py encode → 1-byte reader ${payload.length}`);

    for (const binary of [false, true]) {
      const nativeEncoded = Buffer.from(quotedPrintableEncode(payload, { binary }));
      assert.deepEqual(pythonQuopri('decode', nativeEncoded), payload, `native encode binary=${binary} → py decode ${payload.length}`);
      const writer = new QuotedPrintableWriter({ binary });
      writer.write(payload);
      assert.deepEqual(pythonQuopri('decode', Buffer.from(writer.finish())), payload, `writer binary=${binary} → py decode ${payload.length}`);
    }
  }
});

test('python3 quopri keeps lone LF; Go/native text-mode quoted-printable emits CRLF', () => {
  const lf = Buffer.from('foo bar\n');
  const pyEncoded = pythonQuopri('encode', lf);
  assert.equal(pyEncoded.toString(), 'foo bar\n');
  assert.deepEqual(Buffer.from(quotedPrintableDecode(pyEncoded)), lf);
  const nativeText = Buffer.from(quotedPrintableEncode(lf, { binary: false }));
  assert.equal(nativeText.toString(), 'foo bar\r\n');
  assert.deepEqual(pythonQuopri('decode', nativeText), Buffer.from('foo bar\r\n'));
});
