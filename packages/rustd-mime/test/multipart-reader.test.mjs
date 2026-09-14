import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MultipartReader, MultipartWriter, QuotedPrintableError, MessageTooLargeError, MultipartError } from '../index.mjs';

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

function headerRecord(header) {
  return { ...header };
}

function assertPartsMatch(parts, goParts) {
  assert.equal(goParts.error ?? '', '');
  assert.equal(parts.length, goParts.parts.length);
  for (let i = 0; i < parts.length; i++) {
    assert.equal(parts[i].formName, goParts.parts[i].formName, `formName[${i}]`);
    assert.equal(parts[i].fileName, goParts.parts[i].fileName, `fileName[${i}]`);
    assert.equal(parts[i].bodyHex, goParts.parts[i].bodyHex, `bodyHex[${i}]`);
    assert.deepEqual(
      headerRecord(parts[i].header),
      headerRecord(goParts.parts[i].header),
      `header[${i}]`,
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

function assertThrowsMultipart(fn, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof MultipartError, err?.constructor?.name);
    assert.equal(err.message, message);
    return true;
  });
}

test('nextPart empty boundary matches Go TestNoBoundary', () => {
  const goEmpty = goRead(Buffer.from('--\r\n\r\n--\r\n'), '');
  assert.equal(goEmpty.error, 'multipart: boundary is empty');
  assert.equal(goEmpty.parts.length, 0);
  assertThrowsMultipart(() => {
    const reader = new MultipartReader({ boundary: '' });
    reader.write(Buffer.from('--\r\n\r\n--\r\n'));
    reader.nextPart();
  }, goEmpty.error);
  assertThrowsMultipart(() => new MultipartReader({ boundary: '' }).nextPart(), goEmpty.error);
});

test('nextPart missing-colon header matches Go textproto', () => {
  const body = Buffer.from('--b\r\nNotAHeader\r\n\r\nx\r\n--b--\r\n');
  const goParts = goRead(body, 'b');
  assert.equal(goParts.error, 'malformed MIME header: missing colon: "NotAHeader"');
  assert.equal(goParts.parts.length, 0);
  assertThrowsMultipart(() => {
    const reader = new MultipartReader({ boundary: 'b' });
    reader.write(body);
    reader.nextPart();
  }, goParts.error);

  const one = new MultipartReader({ boundary: 'b' });
  let threw;
  for (let i = 0; i < body.length; i++) {
    one.write(body.subarray(i, i + 1));
    try {
      assert.equal(one.nextPart(), null);
    } catch (err) {
      threw = err;
      break;
    }
  }
  assert.ok(threw instanceof MultipartError);
  assert.equal(threw.message, goParts.error);
});

test('nextPart missing closer is null here; Go NextPart+Read is unexpected EOF', () => {
  const truncated = [
    Buffer.from(
      '\r\nThis is a multi-part message.  This line is ignored.\r\n--MyBoundary\r\nfoo-bar: baz\r\n\r\nOh no, premature EOF!\r\n',
    ),
    Buffer.from(
      '\r\nThis is a multi-part message.  This line is ignored.\r\n--MyBoundary\r\nfoo-bar: baz\r\n\r\nOh no, premature EOF!\r\n--MyBoundary-\r\n',
    ),
  ];
  for (const body of truncated) {
    const goParts = goRead(body, 'MyBoundary');
    assert.equal(goParts.error, 'unexpected EOF');
    assert.equal(goParts.parts.length, 1);
    assert.equal(goParts.parts[0].header['Foo-Bar'][0], 'baz');
    const reader = new MultipartReader({ boundary: 'MyBoundary' });
    reader.write(body);
    assert.equal(reader.nextPart(), null);
    assert.deepEqual(readAll1Byte('MyBoundary', body), []);
  }

  const noFinal = Buffer.from('--b\r\nContent-Disposition: form-data; name=foo\r\n\r\nhello');
  const goNoFinal = goRead(noFinal, 'b');
  assert.equal(goNoFinal.error, 'unexpected EOF');
  assert.equal(goNoFinal.parts.length, 1);
  assert.equal(goNoFinal.parts[0].formName, 'foo');
  assert.equal(goNoFinal.parts[0].bodyHex, hex(Buffer.from('hello')));
  const reader = new MultipartReader({ boundary: 'b' });
  reader.write(noFinal);
  assert.equal(reader.nextPart(), null);
});

function bodyWithBoundaryLen(n) {
  const boundary = 'x'.repeat(n);
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name=foo\r\n\r\nhello\r\n--${boundary}--\r\n`,
  );
  return { boundary, body };
}

test('nextPart RFC 70-char boundary vs Go; 71-char Reader still parses (Writer rejects)', () => {
  for (const n of [70, 71]) {
    const { boundary, body } = bodyWithBoundaryLen(n);
    const goParts = goRead(body, boundary);
    assert.equal(goParts.error ?? '', '', `go n=${n}`);
    const parts = readAll(boundary, body);
    assertPartsMatch(parts, goParts);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].formName, 'foo');
    assert.equal(parts[0].bodyHex, hex(Buffer.from('hello')));
    assert.deepEqual(readAll1Byte(boundary, body), parts);
  }
  assert.throws(() => new MultipartWriter({ boundary: 'x'.repeat(71) }), MultipartError);
  const w70 = new MultipartWriter({ boundary: 'x'.repeat(70) });
  assert.equal(w70.boundary(), 'x'.repeat(70));
});

test('nextPart LF-only part headers (no CRLF) match Go', () => {
  const body = Buffer.from(
    '--b\nContent-Disposition: form-data; name=foo\n\nhello\n--b--\n',
  );
  const goParts = goRead(body, 'b');
  assert.equal(goParts.error ?? '', '');
  const parts = readAll('b', body);
  assertPartsMatch(parts, goParts);
  assert.equal(parts[0].formName, 'foo');
  assert.equal(parts[0].bodyHex, hex(Buffer.from('hello')));
  assert.deepEqual(readAll1Byte('b', body), parts);

  const mixed = Buffer.from(
    '--b\r\nContent-Disposition: form-data; name=foo\n\nhello\r\n--b--\r\n',
  );
  const goMixed = goRead(mixed, 'b');
  const mixedParts = readAll('b', mixed);
  assertPartsMatch(mixedParts, goMixed);
  assert.deepEqual(readAll1Byte('b', mixed), mixedParts);
});

test('nextPart header without blank CRLF matches Go missing-colon', () => {
  const body = Buffer.from(
    '--b\r\nContent-Disposition: form-data; name=foo\r\nhello\r\n--b--\r\n',
  );
  const goParts = goRead(body, 'b');
  assert.equal(goParts.error, 'malformed MIME header: missing colon: "hello"');
  assert.equal(goParts.parts.length, 0);
  assertThrowsMultipart(() => {
    const reader = new MultipartReader({ boundary: 'b' });
    reader.write(body);
    reader.nextPart();
  }, goParts.error);

  const one = new MultipartReader({ boundary: 'b' });
  let threw;
  for (let i = 0; i < body.length; i++) {
    one.write(body.subarray(i, i + 1));
    try {
      assert.equal(one.nextPart(), null);
    } catch (err) {
      threw = err;
      break;
    }
  }
  assert.ok(threw instanceof MultipartError);
  assert.equal(threw.message, goParts.error);
});

test('nextPart truncated header without newline is null; Go NextPart is EOF', () => {
  const body = Buffer.from('--b\r\nFoo: bar');
  const goParts = goRead(body, 'b');
  assert.equal(goParts.error ?? '', '');
  assert.equal(goParts.parts.length, 0);
  const reader = new MultipartReader({ boundary: 'b' });
  reader.write(body);
  assert.equal(reader.nextPart(), null);
  assert.deepEqual(readAll1Byte('b', body), []);
});

const missingCdOnlyType = Buffer.from(
  '--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n',
);
const missingCdEmptyHeaders = Buffer.from('--b\r\n\r\nhello\r\n--b--\r\n');
const missingCdLfOnly = Buffer.from('--b\nContent-Type: text/plain\n\nhello\n--b--\n');
const missingCdThenPresent = Buffer.from(
  '--b\r\nContent-Type: text/plain\r\n\r\nfirst\r\n--b\r\nContent-Disposition: form-data; name=foo\r\n\r\nsecond\r\n--b--\r\n',
);
const missingCdTwoParts = Buffer.from(
  '--b\r\nContent-Type: text/plain\r\n\r\na\r\n--b\r\nContent-Type: application/octet-stream\r\n\r\nb\r\n--b--\r\n',
);
const emptyCdValue = Buffer.from('--b\r\nContent-Disposition:\r\n\r\nhello\r\n--b--\r\n');
const qpMissingCd = Buffer.from(
  '--b\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nhel=6Co\r\n--b--\r\n',
);

test('nextPart missing Content-Disposition is not an error vs Go', () => {
  for (const [name, body] of [
    ['only-content-type', missingCdOnlyType],
    ['empty-headers', missingCdEmptyHeaders],
    ['lf-only', missingCdLfOnly],
    ['two-parts', missingCdTwoParts],
  ]) {
    const goParts = goRead(body, 'b');
    assert.equal(goParts.error ?? '', '', name);
    const parts = readAll('b', body);
    assertPartsMatch(parts, goParts);
    for (let i = 0; i < parts.length; i++) {
      assert.equal(parts[i].formName, '', `${name} formName[${i}]`);
      assert.equal(parts[i].fileName, '', `${name} fileName[${i}]`);
      assert.equal(parts[i].header['Content-Disposition'], undefined, `${name} CD[${i}]`);
    }
    assert.deepEqual(readAll1Byte('b', body), parts, name);
  }
});

test('nextPart mixed missing then present Content-Disposition vs Go', () => {
  const goParts = goRead(missingCdThenPresent, 'b');
  const parts = readAll('b', missingCdThenPresent);
  assertPartsMatch(parts, goParts);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].formName, '');
  assert.equal(parts[0].header['Content-Disposition'], undefined);
  assert.equal(parts[1].formName, 'foo');
  assert.equal(parts[1].header['Content-Disposition'][0], 'form-data; name=foo');
  assert.deepEqual(readAll1Byte('b', missingCdThenPresent), parts);
});

test('nextPart empty Content-Disposition value vs Go', () => {
  const goParts = goRead(emptyCdValue, 'b');
  const parts = readAll('b', emptyCdValue);
  assertPartsMatch(parts, goParts);
  assert.equal(parts[0].formName, '');
  assert.equal(parts[0].fileName, '');
  assert.deepEqual(parts[0].header['Content-Disposition'], ['']);
  assert.deepEqual(readAll1Byte('b', emptyCdValue), parts);
});

test('nextPart quoted-printable without Content-Disposition vs Go', () => {
  const goParts = goRead(qpMissingCd, 'b');
  const parts = readAll('b', qpMissingCd);
  assertPartsMatch(parts, goParts);
  assert.equal(parts[0].formName, '');
  assert.equal(parts[0].header['Content-Transfer-Encoding'], undefined);
  assert.equal(parts[0].bodyHex, hex(Buffer.from('hello')));
  assert.deepEqual(readAll1Byte('b', qpMissingCd), parts);
});

test('nextPart missing Content-Disposition mid-boundary splits match whole-body', () => {
  for (const body of [missingCdOnlyType, missingCdThenPresent, qpMissingCd]) {
    const whole = assertThreeFeedModes('b', body);
    assertPartsMatch(whole, goRead(body, 'b'));
  }
});

function bodyWithPartCount(n, boundary = 'b') {
  let s = '';
  for (let i = 0; i < n; i++) s += `--${boundary}\r\nContent-Disposition: form-data; name="f${i}"\r\n\r\n${i}\r\n`;
  s += `--${boundary}--\r\n`;
  return Buffer.from(s);
}

test('nextPart 1000 parts succeeds vs Go; 1001 also succeeds (limit is ReadForm)', () => {
  const body1000 = bodyWithPartCount(1000);
  const go1000 = goRead(body1000, 'b');
  assert.equal(go1000.error ?? '', '');
  assert.equal(go1000.parts.length, 1000);
  const parts1000 = readAll('b', body1000);
  assertPartsMatch(parts1000, go1000);
  assert.equal(parts1000[0].formName, 'f0');
  assert.equal(parts1000[999].formName, 'f999');
  assert.equal(parts1000[999].bodyHex, hex(Buffer.from('999')));

  const body1001 = bodyWithPartCount(1001);
  const go1001 = goRead(body1001, 'b');
  assert.equal(go1001.error ?? '', '');
  assert.equal(go1001.parts.length, 1001, 'Go NextPart has no 1000-part cap');
  const parts1001 = readAll('b', body1001);
  assertPartsMatch(parts1001, go1001);
  assert.equal(parts1001[1000].formName, 'f1000');
  assert.equal(parts1001[1000].bodyHex, hex(Buffer.from('1000')));
});

test('nextPart ignores GODEBUG multipartmaxparts (ReadForm-only in Go 1.24)', () => {
  const body = bodyWithPartCount(4);
  const goParts = goReadEnv(body, 'b', { GODEBUG: 'multipartmaxparts=3' });
  assert.equal(goParts.error ?? '', '');
  assert.equal(goParts.parts.length, 4);
  const parts = readAll('b', body);
  assertPartsMatch(parts, goParts);
  assert.deepEqual(readAll1Byte('b', body), parts);
});

function goReadForm(body, boundary, maxMemory = 1 << 20, extraEnv = {}) {
  const generated = go(
    ['-multipart-readform'],
    JSON.stringify({ boundary, bodyHex: hex(body), maxMemory }),
    extraEnv,
  );
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout);
}

function nativeReadForm(boundary, body, maxMemory = 1 << 20, extra = {}) {
  const reader = new MultipartReader({ boundary, ...extra });
  reader.write(body);
  return reader.readForm(maxMemory);
}

function assertFormValuesMatch(form, goForm) {
  assert.equal(goForm.error ?? '', '');
  const keys = Object.keys(form.value).sort();
  assert.deepEqual(keys, Object.keys(goForm.value).sort());
  for (const key of keys) {
    assert.deepEqual(form.value[key], goForm.value[key], `value[${key}]`);
  }
}

test('readForm 1000 parts succeeds vs Go; 1001 is MessageTooLargeError', () => {
  const body1000 = bodyWithPartCount(1000);
  const go1000 = goReadForm(body1000, 'b');
  const form1000 = nativeReadForm('b', body1000);
  assertFormValuesMatch(form1000, go1000);
  assert.equal(Object.keys(form1000.value).length, 1000);
  assert.equal(form1000.value.f0[0], '0');
  assert.equal(form1000.value.f999[0], '999');
  assert.deepEqual(form1000.file, Object.create(null));
  assert.equal(Object.keys(go1000.file).length, 0);

  const body1001 = bodyWithPartCount(1001);
  const go1001 = goReadForm(body1001, 'b');
  assert.equal(go1001.error, 'multipart: message too large');
  assert.throws(() => nativeReadForm('b', body1001), (err) => {
    assert.ok(err instanceof MessageTooLargeError);
    assert.equal(err.message, 'multipart: message too large');
    return true;
  });
});

test('readForm maxParts=3 matches GODEBUG multipartmaxparts=3', () => {
  const okBody = bodyWithPartCount(3);
  const goOk = goReadForm(okBody, 'b', 1 << 20, { GODEBUG: 'multipartmaxparts=3' });
  const ok = nativeReadForm('b', okBody, 1 << 20, { maxParts: 3 });
  assertFormValuesMatch(ok, goOk);
  assert.equal(Object.keys(ok.value).length, 3);

  const overBody = bodyWithPartCount(4);
  const goOver = goReadForm(overBody, 'b', 1 << 20, { GODEBUG: 'multipartmaxparts=3' });
  assert.equal(goOver.error, 'multipart: message too large');
  assert.throws(
    () => nativeReadForm('b', overBody, 1 << 20, { maxParts: 3 }),
    MessageTooLargeError,
  );
});

test('readForm maxMemory header cap vs Go (name=x, 100-byte value)', () => {
  const body = Buffer.from(
    '--b\r\nContent-Disposition: form-data; name="x"\r\n\r\n' + '1'.repeat(100) + '\r\n--b--\r\n',
  );
  const failAt = 638 - (10 << 20);
  const goFail = goReadForm(body, 'b', failAt - 1);
  assert.equal(goFail.error, 'multipart: message too large');
  assert.throws(() => nativeReadForm('b', body, failAt - 1), MessageTooLargeError);
  const goOk = goReadForm(body, 'b', failAt);
  const form = nativeReadForm('b', body, failAt);
  assertFormValuesMatch(form, goOk);
  assert.equal(form.value.x[0].length, 100);
  const goZero = goReadForm(body, 'b', 0);
  assertFormValuesMatch(nativeReadForm('b', body, 0), goZero);
});

test('readForm maxMemory value body vs Go (largetext 1024 bytes)', () => {
  const body = Buffer.from(
    '--b\r\nContent-Disposition: form-data; name="largetext"\r\n\r\n' + '1'.repeat(1024) + '\r\n--b--\r\n',
  );
  const failAt = 1233 - (10 << 20);
  const goFail = goReadForm(body, 'b', failAt - 1);
  assert.equal(goFail.error, 'multipart: message too large');
  assert.throws(() => nativeReadForm('b', body, failAt - 1), (err) => {
    assert.ok(err instanceof MessageTooLargeError);
    assert.equal(err.message, 'multipart: message too large');
    return true;
  });
  const goOk = goReadForm(body, 'b', failAt);
  const form = nativeReadForm('b', body, failAt);
  assertFormValuesMatch(form, goOk);
  assert.equal(form.value.largetext[0], '1'.repeat(1024));
});

test('readForm maxMemory two values vs Go (hello/world)', () => {
  const body = Buffer.from(
    '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nhello\r\n--b\r\nContent-Disposition: form-data; name="b"\r\n\r\nworld\r\n--b--\r\n',
  );
  const failAt = 844 - (10 << 20);
  const goFail = goReadForm(body, 'b', failAt - 1);
  assert.equal(goFail.error, 'multipart: message too large');
  assert.throws(() => nativeReadForm('b', body, failAt - 1), MessageTooLargeError);
  const goOk = goReadForm(body, 'b', failAt);
  const form = nativeReadForm('b', body, failAt);
  assertFormValuesMatch(form, goOk);
  assert.equal(form.value.a[0], 'hello');
  assert.equal(form.value.b[0], 'world');
});

test('readForm maxMemory=-10MiB is MessageTooLargeError vs Go', () => {
  const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="x"\r\n\r\nhello\r\n--b--\r\n');
  const go = goReadForm(body, 'b', -(10 << 20));
  assert.equal(go.error, 'multipart: message too large');
  assert.throws(() => nativeReadForm('b', body, -(10 << 20)), MessageTooLargeError);
});

test('readForm 1000 files succeeds vs Go; 1001 is MessageTooLargeError', () => {
  const w1000 = new MultipartWriter({ boundary: 'b' });
  for (let i = 0; i < 1000; i++) {
    const p = w1000.createFormFile(`file${i}`, `file${i}`);
    p.write(Buffer.from(`value ${i}`));
    p.end();
  }
  const body1000 = w1000.bytes();
  const go1000 = goReadForm(body1000, 'b');
  const form1000 = nativeReadForm('b', body1000);
  assert.equal(go1000.error ?? '', '');
  assert.equal(Object.keys(form1000.file).length, 1000);
  assert.equal(Object.keys(go1000.file).length, 1000);
  assert.equal(form1000.file.file0[0].filename, go1000.file.file0[0].filename);
  assert.equal(form1000.file.file0[0].size, go1000.file.file0[0].size);
  assert.equal(hex(form1000.file.file0[0].content), go1000.file.file0[0].bodyHex);
  assert.equal(form1000.file.file999[0].filename, 'file999');
  assert.deepEqual(form1000.value, Object.create(null));

  const w1001 = new MultipartWriter({ boundary: 'b' });
  for (let i = 0; i < 1001; i++) {
    const p = w1001.createFormFile(`file${i}`, `file${i}`);
    p.write(Buffer.from(`value ${i}`));
    p.end();
  }
  const body1001 = w1001.bytes();
  const go1001 = goReadForm(body1001, 'b');
  assert.equal(go1001.error, 'multipart: message too large');
  assert.throws(() => nativeReadForm('b', body1001), MessageTooLargeError);
});
