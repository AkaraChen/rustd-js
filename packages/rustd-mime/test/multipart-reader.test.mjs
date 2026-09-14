import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MultipartReader, MultipartWriter, QuotedPrintableError } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/mime', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20,
    env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 120000,
  });
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function unhex(s) {
  return Buffer.from(s, 'hex');
}

function goWrite(fields, boundary) {
  const generated = go(['-multipart-write'], JSON.stringify({ boundary, fields }));
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout);
}

function goRead(body, boundary, raw = false) {
  const generated = go(['-multipart-read'], JSON.stringify({ boundary, bodyHex: hex(body), raw }));
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout);
}

function readAll(boundary, body, raw = false) {
  const reader = new MultipartReader({ boundary });
  reader.write(body);
  const parts = [];
  for (;;) {
    const part = raw ? reader.nextRawPart() : reader.nextPart();
    if (part == null) break;
    parts.push({
      formName: part.formName(),
      fileName: part.fileName(),
      header: part.header,
      bodyHex: hex(part.read()),
    });
  }
  return parts;
}

test('nextPart of Go Writer one-part body matches Go NewReader', () => {
  const fields = [{ name: 'foo', value: 'bar', mode: 'writeField' }];
  const golden = goWrite(fields, 'boundary');
  assert.equal(golden.error ?? '', '');
  const body = unhex(golden.bodyHex);
  const goParts = goRead(body, 'boundary');
  assert.equal(goParts.error ?? '', '');
  assert.equal(goParts.parts.length, 1);
  const parts = readAll('boundary', body);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].formName, goParts.parts[0].formName);
  assert.equal(parts[0].fileName, goParts.parts[0].fileName);
  assert.equal(parts[0].bodyHex, goParts.parts[0].bodyHex);
  assert.equal(
    parts[0].header['Content-Disposition'][0],
    goParts.parts[0].header['Content-Disposition'][0],
  );
});

test('nextPart of Go CreateFormField one-part body matches Go NewReader', () => {
  const fields = [{ name: 'field', value: 'chunk-achunk-b', mode: 'createFormField' }];
  const golden = goWrite(fields, 'xyz');
  assert.equal(golden.error ?? '', '');
  const body = unhex(golden.bodyHex);
  const goParts = goRead(body, 'xyz');
  const parts = readAll('xyz', body);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].formName, 'field');
  assert.equal(parts[0].fileName, '');
  assert.equal(parts[0].bodyHex, goParts.parts[0].bodyHex);
});

test('nextPart of native Writer one-part roundtrips vs Go NewReader', () => {
  const w = new MultipartWriter({ boundary: 'abc' });
  w.writeField('key', 'val');
  const body = w.bytes();
  const goParts = goRead(body, 'abc');
  assert.equal(goParts.error ?? '', '');
  const parts = readAll('abc', body);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].formName, goParts.parts[0].formName);
  assert.equal(parts[0].bodyHex, goParts.parts[0].bodyHex);
  assert.equal(parts[0].bodyHex, hex(Buffer.from('val')));
});

test('nextPart returns null after the last part', () => {
  const golden = goWrite([{ name: 'only', value: '', mode: 'writeField' }], 'b');
  const reader = new MultipartReader({ boundary: 'b' });
  reader.write(unhex(golden.bodyHex));
  const part = reader.nextPart();
  assert.equal(part.formName(), 'only');
  assert.equal(hex(part.read()), '');
  assert.equal(reader.nextPart(), null);
  assert.equal(reader.nextPart(), null);
});

function assertPartsMatch(parts, goParts) {
  assert.equal(goParts.error ?? '', '');
  assert.equal(parts.length, goParts.parts.length);
  for (let i = 0; i < parts.length; i++) {
    assert.equal(parts[i].formName, goParts.parts[i].formName, `formName[${i}]`);
    assert.equal(parts[i].fileName, goParts.parts[i].fileName, `fileName[${i}]`);
    assert.equal(parts[i].bodyHex, goParts.parts[i].bodyHex, `bodyHex[${i}]`);
    assert.equal(
      parts[i].header['Content-Disposition'][0],
      goParts.parts[i].header['Content-Disposition'][0],
      `Content-Disposition[${i}]`,
    );
  }
}

test('nextPart of Go Writer multi-field body matches Go NewReader', () => {
  const fields = [
    { name: 'foo', value: 'bar', mode: 'writeField' },
    { name: 'a"b', value: 'x\\y', mode: 'writeField' },
    { name: 'empty', value: '', mode: 'writeField' },
  ];
  const golden = goWrite(fields, 'boundary');
  assert.equal(golden.error ?? '', '');
  const body = unhex(golden.bodyHex);
  const goParts = goRead(body, 'boundary');
  const parts = readAll('boundary', body);
  assertPartsMatch(parts, goParts);
  assert.equal(parts.length, 3);
  assert.equal(parts[2].bodyHex, '');
});

test('nextPart of Go mixed CreateFormField+WriteField body matches Go NewReader', () => {
  const fields = [
    { name: 'note', value: 'hello\r\nworld', mode: 'createFormField' },
    { name: 'n', value: '1', mode: 'writeField' },
  ];
  const golden = goWrite(fields, 'MIMEBOUNDARY');
  assert.equal(golden.error ?? '', '');
  const body = unhex(golden.bodyHex);
  const goParts = goRead(body, 'MIMEBOUNDARY');
  const parts = readAll('MIMEBOUNDARY', body);
  assertPartsMatch(parts, goParts);
  assert.equal(parts[0].bodyHex, hex(Buffer.from('hello\r\nworld')));
});

test('nextPart of native Writer multi-field roundtrips vs Go NewReader', () => {
  const w = new MultipartWriter({ boundary: 'abc' });
  w.writeField('key', 'val');
  w.writeField('empty', '');
  const part = w.createFormField('note');
  part.write(Buffer.from('chunk-a'));
  part.write(Buffer.from('chunk-b'));
  part.end();
  const body = w.bytes();
  const goParts = goRead(body, 'abc');
  const parts = readAll('abc', body);
  assertPartsMatch(parts, goParts);
  assert.equal(parts.length, 3);
  assert.equal(parts[2].formName, 'note');
  assert.equal(parts[2].bodyHex, hex(Buffer.from('chunk-achunk-b')));
});

test('nextPart keeps a body that contains the boundary without a CRLF prefix', () => {
  const fields = [
    { name: 'keep', value: 'hello--bound--world', mode: 'writeField' },
    { name: 'after', value: 'ok', mode: 'writeField' },
  ];
  const golden = goWrite(fields, 'bound');
  const body = unhex(golden.bodyHex);
  const goParts = goRead(body, 'bound');
  const parts = readAll('bound', body);
  assertPartsMatch(parts, goParts);
  assert.equal(parts[0].bodyHex, hex(Buffer.from('hello--bound--world')));
});

function qpFormBody(cte) {
  return Buffer.from(
    `--0016e68ee29c5d515f04cedf6733\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=text\r\nContent-Transfer-Encoding: ${cte}\r\n\r\nwords words words words words words words words words words words words wor=\r\nds words words words words words words words words words words words words =\r\nwords words words words words words words words words words words words wor=\r\nds words words words words words words words words words words words words =\r\nwords words words words words words words words words\r\n--0016e68ee29c5d515f04cedf6733\r\nContent-Type: text/plain; charset=ISO-8859-1\r\nContent-Disposition: form-data; name=submit\r\n\r\nSubmit\r\n--0016e68ee29c5d515f04cedf6733--`,
  );
}

const qpWant = 'words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words words';

for (const cte of ['quoted-printable', 'Quoted-PRINTABLE']) {
  test(`nextPart auto-decodes Content-Transfer-Encoding ${cte} vs Go NextPart`, () => {
    const body = qpFormBody(cte);
    const goParts = goRead(body, '0016e68ee29c5d515f04cedf6733');
    const parts = readAll('0016e68ee29c5d515f04cedf6733', body);
    assertPartsMatch(parts, goParts);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].formName, 'text');
    assert.equal(parts[0].header['Content-Transfer-Encoding'], undefined);
    assert.equal(goParts.parts[0].header['Content-Transfer-Encoding'], undefined);
    assert.equal(parts[0].bodyHex, hex(Buffer.from(qpWant)));
    assert.equal(parts[1].formName, 'submit');
    assert.equal(parts[1].bodyHex, hex(Buffer.from('Submit')));
  });
}

test('nextRawPart keeps quoted-printable CTE; nextPart then decodes (Go TestRawPart)', () => {
  const body = Buffer.from(
    `--0016e68ee29c5d515f04cedf6733\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<div dir=3D"ltr">Hello World.</div>\r\n--0016e68ee29c5d515f04cedf6733\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<div dir=3D"ltr">Hello World.</div>\r\n--0016e68ee29c5d515f04cedf6733--`,
  );
  const boundary = '0016e68ee29c5d515f04cedf6733';
  const goRaw = go(['-multipart-read'], JSON.stringify({
    boundary, bodyHex: hex(body), raw: true,
  }));
  assert.equal(goRaw.status, 0, goRaw.stderr);
  const goRawParts = JSON.parse(goRaw.stdout);
  assert.equal(goRawParts.error ?? '', '');
  assert.equal(goRawParts.parts[0].header['Content-Transfer-Encoding'][0], 'quoted-printable');
  assert.equal(goRawParts.parts[0].bodyHex, hex(Buffer.from('<div dir=3D"ltr">Hello World.</div>')));

  const reader = new MultipartReader({ boundary });
  reader.write(body);
  const raw = reader.nextRawPart();
  assert.equal(raw.header['Content-Transfer-Encoding'][0], 'quoted-printable');
  assert.equal(hex(raw.read()), hex(Buffer.from('<div dir=3D"ltr">Hello World.</div>')));
  const decoded = reader.nextPart();
  assert.equal(decoded.header['Content-Transfer-Encoding'], undefined);
  assert.equal(hex(decoded.read()), hex(Buffer.from('<div dir="ltr">Hello World.</div>')));
  assert.equal(reader.nextPart(), null);

  const goMixedFirst = goRead(body, boundary, true);
  assert.equal(goMixedFirst.parts[0].bodyHex, hex(Buffer.from('<div dir=3D"ltr">Hello World.</div>')));
});

test('nextPart leaves non-quoted-printable Content-Transfer-Encoding', () => {
  const body = Buffer.from(
    '--b\r\nContent-Transfer-Encoding: 7bit\r\nContent-Disposition: form-data; name=plain\r\n\r\nhi\r\n--b--',
  );
  const goParts = goRead(body, 'b');
  const parts = readAll('b', body);
  assertPartsMatch(parts, goParts);
  assert.equal(parts[0].header['Content-Transfer-Encoding'][0], '7bit');
  assert.equal(parts[0].bodyHex, hex(Buffer.from('hi')));
});

test('nextPart quoted-printable decode error is QuotedPrintableError', () => {
  const body = Buffer.from(
    '--b\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nfoo\x00bar\r\n--b--',
  );
  const goParts = goRead(body, 'b');
  assert.notEqual(goParts.error ?? '', '');
  const reader = new MultipartReader({ boundary: 'b' });
  reader.write(body);
  assert.throws(() => reader.nextPart(), QuotedPrintableError);
});
