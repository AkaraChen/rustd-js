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

test('python quopri decodes native quoted-printable output', () => {
  const payload = Buffer.from("Now's the time for all folk to come to the aid of their country.");
  const encoded = Buffer.from(quotedPrintableEncode(payload)).toString();
  const py = spawnSync('python3', ['-c', 'import sys,quopri; sys.stdout.buffer.write(quopri.decodestring(sys.stdin.buffer.read()))'], {
    input: Buffer.from(encoded), timeout: 10000,
  });
  assert.equal(py.status, 0, String(py.stderr ?? ''));
  assert.equal(Buffer.from(py.stdout).toString(), payload.toString());
});
