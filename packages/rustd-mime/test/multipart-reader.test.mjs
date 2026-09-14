import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MultipartReader, MultipartWriter, QuotedPrintableError, MessageTooLargeError } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
function go(args = [], input, extraEnv = {}) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/mime', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20,
    env: { ...process.env, GOTOOLCHAIN: 'local', ...extraEnv }, timeout: 120000,
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

function snapshotPart(part) {
  return {
    formName: part.formName(),
    fileName: part.fileName(),
    header: part.header,
    bodyHex: hex(part.read()),
  };
}

function drain(reader, parts, raw) {
  for (;;) {
    const part = raw ? reader.nextRawPart() : reader.nextPart();
    if (part == null) break;
    parts.push(snapshotPart(part));
  }
}

function readAll(boundary, body, raw = false) {
  const reader = new MultipartReader({ boundary });
  reader.write(body);
  const parts = [];
  drain(reader, parts, raw);
  return parts;
}

function readAll1Byte(boundary, body, raw = false) {
  const reader = new MultipartReader({ boundary });
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    reader.write(body.subarray(i, i + 1));
    drain(reader, parts, raw);
  }
  drain(reader, parts, raw);
  return parts;
}

/** mulberry32; issue #9 §4.3c requires a fixed seed so mid-boundary splits are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function splitNearBoundary(body, boundary, seed) {
  body = Buffer.from(body);
  const token = Buffer.from(`--${boundary}`);
  const cuts = new Set([0, body.length]);
  const rng = mulberry32(seed);
  let from = 0;
  while (from <= body.length - token.length) {
    const idx = body.indexOf(token, from);
    if (idx < 0) break;
    const interior = 1 + Math.floor(rng() * (token.length - 1));
    cuts.add(idx + interior);
    if (rng() < 0.5 && idx > 0) cuts.add(idx);
    if (rng() < 0.5) cuts.add(Math.min(body.length, idx + token.length));
    from = idx + 1;
  }
  const points = [...cuts].sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i] < points[i + 1]) chunks.push(body.subarray(points[i], points[i + 1]));
  }
  return chunks;
}

function readAllChunks(boundary, chunks, raw = false) {
  const reader = new MultipartReader({ boundary });
  const parts = [];
  for (const chunk of chunks) {
    reader.write(chunk);
    drain(reader, parts, raw);
  }
  drain(reader, parts, raw);
  return parts;
}

function readAllRandomNearBoundary(boundary, body, seed, raw = false) {
  return readAllChunks(boundary, splitNearBoundary(body, boundary, seed), raw);
}

const MID_BOUNDARY_SEED = 0x4d494d45; // 'MIME'

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

test('nextPart 1-byte write matches whole-body for Go Writer fields', () => {
  const fields = [
    { name: 'foo', value: 'bar', mode: 'writeField' },
    { name: 'a"b', value: 'x\\y', mode: 'writeField' },
    { name: 'empty', value: '', mode: 'writeField' },
    { name: 'keep', value: 'hello--boundary--world', mode: 'writeField' },
  ];
  const golden = goWrite(fields, 'boundary');
  const body = unhex(golden.bodyHex);
  const whole = readAll('boundary', body);
  const oneByte = readAll1Byte('boundary', body);
  const goParts = goRead(body, 'boundary');
  assertPartsMatch(whole, goParts);
  assert.deepEqual(oneByte, whole);
});

test('nextPart 1-byte write matches whole-body for native createPart/createFormFile', () => {
  const w = new MultipartWriter({ boundary: 'xyzzy' });
  w.createPart({ 'Content-Disposition': ['form-data; name="note"'] }).write(Buffer.from('hi'));
  const file = w.createFormFile('file', 'a.txt');
  file.write(Buffer.from([0, 255, 10]));
  file.end();
  const body = w.bytes();
  const whole = readAll('xyzzy', body);
  const oneByte = readAll1Byte('xyzzy', body);
  assert.deepEqual(oneByte, whole);
  const goParts = goRead(body, 'xyzzy');
  assertPartsMatch(whole, goParts);
});

test('nextPart 1-byte write matches whole-body for quoted-printable CTE', () => {
  const body = qpFormBody('quoted-printable');
  const boundary = '0016e68ee29c5d515f04cedf6733';
  const whole = readAll(boundary, body);
  const oneByte = readAll1Byte(boundary, body);
  assert.deepEqual(oneByte, whole);
  assertPartsMatch(whole, goRead(body, boundary));
});

test('nextRawPart 1-byte write matches whole-body', () => {
  const body = Buffer.from(
    `--0016e68ee29c5d515f04cedf6733\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<div dir=3D"ltr">Hello World.</div>\r\n--0016e68ee29c5d515f04cedf6733--`,
  );
  const boundary = '0016e68ee29c5d515f04cedf6733';
  assert.deepEqual(readAll1Byte(boundary, body, true), readAll(boundary, body, true));
});

test('nextPart returns null (does not throw) after a 1-byte prefix', () => {
  const golden = goWrite([{ name: 'only', value: 'x', mode: 'writeField' }], 'b');
  const body = unhex(golden.bodyHex);
  const reader = new MultipartReader({ boundary: 'b' });
  reader.write(body.subarray(0, 1));
  assert.equal(reader.nextPart(), null);
  reader.write(body.subarray(1));
  const part = reader.nextPart();
  assert.equal(part.formName(), 'only');
  assert.equal(hex(part.read()), hex(Buffer.from('x')));
  assert.equal(reader.nextPart(), null);
});

function assertThreeFeedModes(boundary, body, raw = false) {
  const whole = readAll(boundary, body, raw);
  const oneByte = readAll1Byte(boundary, body, raw);
  const mid = readAllRandomNearBoundary(boundary, body, MID_BOUNDARY_SEED, raw);
  assert.deepEqual(oneByte, whole);
  assert.deepEqual(mid, whole);
  const chunks = splitNearBoundary(body, boundary, MID_BOUNDARY_SEED);
  assert.ok(chunks.some((c) => c.length > 1), 'mid-boundary feed uses multi-byte chunks');
  assert.ok(chunks.length > 1, 'mid-boundary feed actually splits the body');
  return whole;
}

test('nextPart random mid-boundary splits match whole-body and 1-byte for Go Writer fields', () => {
  const fields = [
    { name: 'foo', value: 'bar', mode: 'writeField' },
    { name: 'a"b', value: 'x\\y', mode: 'writeField' },
    { name: 'empty', value: '', mode: 'writeField' },
    { name: 'keep', value: 'hello--boundary--world', mode: 'writeField' },
  ];
  const golden = goWrite(fields, 'boundary');
  const body = unhex(golden.bodyHex);
  const whole = assertThreeFeedModes('boundary', body);
  assertPartsMatch(whole, goRead(body, 'boundary'));
});

test('nextPart random mid-boundary splits match whole-body and 1-byte for native createPart/createFormFile', () => {
  const w = new MultipartWriter({ boundary: 'xyzzy' });
  w.createPart({ 'Content-Disposition': ['form-data; name="note"'] }).write(Buffer.from('hi'));
  const file = w.createFormFile('file', 'a.txt');
  file.write(Buffer.from([0, 255, 10]));
  file.end();
  const body = w.bytes();
  const whole = assertThreeFeedModes('xyzzy', body);
  assertPartsMatch(whole, goRead(body, 'xyzzy'));
});

test('nextPart random mid-boundary splits match whole-body and 1-byte for quoted-printable CTE', () => {
  const body = qpFormBody('quoted-printable');
  const boundary = '0016e68ee29c5d515f04cedf6733';
  const whole = assertThreeFeedModes(boundary, body);
  assertPartsMatch(whole, goRead(body, boundary));
});

test('nextRawPart random mid-boundary splits match whole-body and 1-byte', () => {
  const body = Buffer.from(
    `--0016e68ee29c5d515f04cedf6733\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<div dir=3D"ltr">Hello World.</div>\r\n--0016e68ee29c5d515f04cedf6733--`,
  );
  const boundary = '0016e68ee29c5d515f04cedf6733';
  assertThreeFeedModes(boundary, body, true);
});

function partWithHeaderCount(n, boundary = 'b') {
  let s = `--${boundary}\r\n`;
  for (let i = 0; i < n; i++) s += `X-${i}: v\r\n`;
  s += `\r\nx\r\n--${boundary}--\r\n`;
  return Buffer.from(s);
}

function goReadEnv(body, boundary, extraEnv) {
  const generated = go(
    ['-multipart-read'],
    JSON.stringify({ boundary, bodyHex: hex(body), raw: false }),
    extraEnv,
  );
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout);
}

test('nextPart 10000 headers succeeds vs Go; 10001 is MessageTooLargeError', () => {
  const okBody = partWithHeaderCount(10000);
  const goOk = goRead(okBody, 'b');
  assert.equal(goOk.error ?? '', '');
  assert.equal(goOk.parts.length, 1);
  assert.equal(Object.keys(goOk.parts[0].header).length, 10000);
  const parts = readAll('b', okBody);
  assert.equal(parts.length, 1);
  assert.equal(Object.keys(parts[0].header).length, 10000);
  assert.equal(parts[0].bodyHex, goOk.parts[0].bodyHex);
  assert.equal(parts[0].header['X-0'][0], 'v');
  assert.equal(parts[0].header['X-9999'][0], goOk.parts[0].header['X-9999'][0]);

  const overBody = partWithHeaderCount(10001);
  const goOver = goRead(overBody, 'b');
  assert.equal(goOver.error, 'multipart: message too large');
  assert.equal(goOver.parts.length, 0);
  const reader = new MultipartReader({ boundary: 'b' });
  reader.write(overBody);
  assert.throws(() => reader.nextPart(), (err) => {
    assert.ok(err instanceof MessageTooLargeError);
    assert.equal(err.message, 'multipart: message too large');
    return true;
  });
});

test('nextPart maxHeadersPerPart=3 matches GODEBUG multipartmaxheaders=3', () => {
  const okBody = partWithHeaderCount(3);
  const goOk = goReadEnv(okBody, 'b', { GODEBUG: 'multipartmaxheaders=3' });
  assert.equal(goOk.error ?? '', '');
  const ok = new MultipartReader({ boundary: 'b', maxHeadersPerPart: 3 });
  ok.write(okBody);
  const part = ok.nextPart();
  assert.equal(Object.keys(part.header).length, 3);
  assert.equal(hex(part.read()), goOk.parts[0].bodyHex);

  const overBody = partWithHeaderCount(4);
  const goOver = goReadEnv(overBody, 'b', { GODEBUG: 'multipartmaxheaders=3' });
  assert.equal(goOver.error, 'multipart: message too large');
  const over = new MultipartReader({ boundary: 'b', maxHeadersPerPart: 3 });
  over.write(overBody);
  assert.throws(() => over.nextPart(), MessageTooLargeError);
});

test('nextPart returns null after a chunk that ends inside the opening boundary', () => {
  const golden = goWrite([{ name: 'only', value: 'x', mode: 'writeField' }], 'boundary');
  const body = unhex(golden.bodyHex);
  const token = Buffer.from('--boundary');
  const idx = body.indexOf(token);
  assert.ok(idx >= 0);
  const reader = new MultipartReader({ boundary: 'boundary' });
  reader.write(body.subarray(0, idx + 4)); // '--bo'
  assert.equal(reader.nextPart(), null);
  reader.write(body.subarray(idx + 4));
  const part = reader.nextPart();
  assert.equal(part.formName(), 'only');
  assert.equal(hex(part.read()), hex(Buffer.from('x')));
  assert.equal(reader.nextPart(), null);
});
