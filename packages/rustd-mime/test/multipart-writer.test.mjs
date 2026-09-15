import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import {
  MultipartWriter, MultipartError, fileContentDisposition,
  mimeHeaderSet, mimeHeaderAdd,
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

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function goWrite(fields, boundary = 'boundary') {
  const generated = go(['-multipart-write'], JSON.stringify({ boundary, fields }));
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout);
}

function goRead(body, boundary) {
  const generated = go(['-multipart-read'], JSON.stringify({ boundary, bodyHex: hex(body) }));
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout);
}

test('writeField bytes match Go multipart.Writer (fixed boundary)', () => {
  const fields = [
    { name: 'foo', value: 'bar', mode: 'writeField' },
    { name: 'a"b', value: 'x\\y', mode: 'writeField' },
    { name: 'empty', value: '', mode: 'writeField' },
  ];
  const w = new MultipartWriter({ boundary: 'boundary' });
  for (const f of fields) w.writeField(f.name, f.value);
  const body = w.bytes();
  const golden = goWrite(fields, 'boundary');
  assert.equal(golden.error ?? '', '');
  assert.equal(hex(body), golden.bodyHex);
  assert.equal(w.formDataContentType(), golden.contentType);
});

test('createFormField + write bytes match Go CreateFormField', () => {
  const fields = [
    { name: 'note', value: 'hello\r\nworld', mode: 'createFormField' },
    { name: 'n', value: '1', mode: 'writeField' },
  ];
  const w = new MultipartWriter({ boundary: 'MIMEBOUNDARY' });
  const part = w.createFormField('note');
  part.write(Buffer.from('hello\r\nworld'));
  part.end();
  w.writeField('n', '1');
  const body = w.bytes();
  const golden = goWrite(fields, 'MIMEBOUNDARY');
  assert.equal(golden.error ?? '', '');
  assert.equal(hex(body), golden.bodyHex);
});

test('writeField one-part roundtrip vs Go multipart.NewReader', () => {
  const w = new MultipartWriter({ boundary: 'abc' });
  w.writeField('key', 'val');
  const body = w.bytes();
  const parsed = goRead(body, 'abc');
  assert.equal(parsed.error ?? '', '');
  assert.equal(parsed.parts.length, 1);
  assert.equal(parsed.parts[0].formName, 'key');
  assert.equal(parsed.parts[0].fileName, '');
  assert.equal(parsed.parts[0].bodyHex, hex(Buffer.from('val')));
  assert.equal(parsed.parts[0].header['Content-Disposition'][0], 'form-data; name="key"');
});

test('createFormField one-part roundtrip vs Go NewReader', () => {
  const w = new MultipartWriter({ boundary: 'xyz' });
  const part = w.createFormField('field');
  part.write(Buffer.from('chunk-a'));
  part.write(Buffer.from('chunk-b'));
  part.end();
  const body = w.bytes();
  const parsed = goRead(body, 'xyz');
  assert.equal(parsed.error ?? '', '');
  assert.equal(parsed.parts.length, 1);
  assert.equal(parsed.parts[0].formName, 'field');
  assert.equal(parsed.parts[0].bodyHex, hex(Buffer.from('chunk-achunk-b')));
});

test('setBoundary matches Go validation table', () => {
  const ok = ['abc', 'x'.repeat(70), 'my-separator', 'with space', '(boundary)'];
  const bad = ['', 'ungültig', '!', 'x'.repeat(71), 'bad!ascii!', 'badspace '];
  for (const b of ok) {
    const w = new MultipartWriter();
    w.setBoundary(b);
    assert.equal(w.boundary(), b);
  }
  for (const b of bad) {
    const w = new MultipartWriter();
    assert.throws(() => w.setBoundary(b), MultipartError);
  }
  const w = new MultipartWriter({ boundary: 'early' });
  w.writeField('a', 'b');
  assert.throws(() => w.setBoundary('late'), (err) => {
    assert.ok(err instanceof MultipartError);
    assert.equal(err.message, 'mime: SetBoundary called after write');
    return true;
  });
});

test('fileContentDisposition matches Go CreateFormFile Content-Disposition', () => {
  const cases = [
    { fieldname: 'file', filename: 'a.txt' },
    { fieldname: 'a"b', filename: 'x\\y.png' },
    { fieldname: 'empty', filename: '' },
    { fieldname: 'f', filename: 'name with space.bin' },
  ];
  for (const c of cases) {
    const generated = go(['-file-content-disposition'], JSON.stringify(c));
    assert.equal(generated.status, 0, generated.stderr);
    const golden = JSON.parse(generated.stdout);
    assert.equal(fileContentDisposition(c.fieldname, c.filename), golden.value);
    assert.equal(golden.contentType, 'application/octet-stream');
    assert.equal(golden.formName, c.fieldname);
    // Go Part.FileName applies filepath.Base for the host OS. The wire header
    // above must still preserve the complete quoted filename on every platform.
    assert.equal(golden.fileName, c.filename === '' ? '' : basename(c.filename));
  }
});

test('createFormFile bytes match Go multipart.Writer CreateFormFile', () => {
  const fields = [
    { name: 'file', filename: 'a.txt', value: 'hello', mode: 'createFormFile' },
    { name: 'note', value: 'x', mode: 'writeField' },
  ];
  const w = new MultipartWriter({ boundary: 'boundary' });
  const part = w.createFormFile('file', 'a.txt');
  part.write(Buffer.from('hello'));
  part.end();
  w.writeField('note', 'x');
  const body = w.bytes();
  const golden = goWrite(fields, 'boundary');
  assert.equal(golden.error ?? '', '');
  assert.equal(hex(body), golden.bodyHex);
});

test('createFormFile quoted names and binary body vs Go', () => {
  const payload = Buffer.from([0, 1, 255, 10, 13]);
  const fields = [
    {
      name: 'a"b',
      filename: 'x\\y.bin',
      valueHex: hex(payload),
      mode: 'createFormFile',
    },
  ];
  const w = new MultipartWriter({ boundary: 'MIMEBOUNDARY' });
  const part = w.createFormFile('a"b', 'x\\y.bin');
  part.write(payload);
  part.end();
  const body = w.bytes();
  const golden = goWrite(fields, 'MIMEBOUNDARY');
  assert.equal(golden.error ?? '', '');
  assert.equal(hex(body), golden.bodyHex);
  const parsed = goRead(body, 'MIMEBOUNDARY');
  assert.equal(parsed.error ?? '', '');
  assert.equal(parsed.parts.length, 1);
  assert.equal(parsed.parts[0].formName, 'a"b');
  assert.equal(parsed.parts[0].fileName, basename('x\\y.bin'));
  assert.equal(parsed.parts[0].bodyHex, hex(payload));
  assert.equal(parsed.parts[0].header['Content-Type'][0], 'application/octet-stream');
  assert.equal(
    parsed.parts[0].header['Content-Disposition'][0],
    fileContentDisposition('a"b', 'x\\y.bin'),
  );
});

test('createFormFile empty filename and empty body vs Go NewReader', () => {
  const w = new MultipartWriter({ boundary: 'xyz' });
  const part = w.createFormFile('upload', '');
  part.end();
  const body = w.bytes();
  const golden = goWrite([{ name: 'upload', filename: '', value: '', mode: 'createFormFile' }], 'xyz');
  assert.equal(hex(body), golden.bodyHex);
  const parsed = goRead(body, 'xyz');
  assert.equal(parsed.parts[0].formName, 'upload');
  assert.equal(parsed.parts[0].fileName, '');
  assert.equal(parsed.parts[0].bodyHex, '');
});

test('createPart bytes match Go CreatePart with MIMEHeader Set/Add', () => {
  const header = {};
  mimeHeaderSet(header, 'content-type', 'text/plain');
  mimeHeaderSet(header, 'content-disposition', 'form-data; name="note"');
  mimeHeaderAdd(header, 'X-Custom', 'one');
  mimeHeaderAdd(header, 'x-custom', 'two');
  const fields = [
    { mode: 'createPart', header, value: 'hello' },
    { name: 'after', value: 'x', mode: 'writeField' },
  ];
  const w = new MultipartWriter({ boundary: 'boundary' });
  const part = w.createPart(header);
  part.write(Buffer.from('hello'));
  part.end();
  w.writeField('after', 'x');
  const body = w.bytes();
  const golden = goWrite(fields, 'boundary');
  assert.equal(golden.error ?? '', '');
  assert.equal(hex(body), golden.bodyHex);
});

test('createPart empty header and raw (non-canonical) keys vs Go', () => {
  const empty = {};
  const raw = {
    'content-type': ['text/plain'],
    'X-Z': ['z'],
    'X-A': ['a1', 'a2'],
  };
  const fields = [
    { mode: 'createPart', header: empty, value: '' },
    { mode: 'createPart', header: raw, valueHex: hex(Buffer.from([0, 255])) },
  ];
  const w = new MultipartWriter({ boundary: 'MIMEBOUNDARY' });
  w.createPart(empty).end();
  const part = w.createPart(raw);
  part.write(Buffer.from([0, 255]));
  part.end();
  const body = w.bytes();
  const golden = goWrite(fields, 'MIMEBOUNDARY');
  assert.equal(golden.error ?? '', '');
  assert.equal(hex(body), golden.bodyHex);
  const parsed = goRead(body, 'MIMEBOUNDARY');
  assert.equal(parsed.error ?? '', '');
  assert.equal(parsed.parts.length, 2);
  assert.equal(parsed.parts[0].bodyHex, '');
  assert.equal(parsed.parts[1].header['Content-Type'][0], 'text/plain');
  assert.equal(parsed.parts[1].header['X-A'][0], 'a1');
  assert.equal(parsed.parts[1].header['X-A'][1], 'a2');
  assert.equal(parsed.parts[1].header['X-Z'][0], 'z');
  assert.equal(parsed.parts[1].bodyHex, hex(Buffer.from([0, 255])));
});

test('createPart then createFormFile mix vs Go', () => {
  const header = {};
  mimeHeaderSet(header, 'Content-Type', 'text/plain; charset=utf-8');
  mimeHeaderSet(header, 'Content-Disposition', 'form-data; name="meta"');
  const fields = [
    { mode: 'createPart', header, value: 'json-ish' },
    { name: 'file', filename: 'a.txt', value: 'hi', mode: 'createFormFile' },
  ];
  const w = new MultipartWriter({ boundary: 'xyz' });
  const part = w.createPart(header);
  part.write(Buffer.from('json-ish'));
  part.end();
  const file = w.createFormFile('file', 'a.txt');
  file.write(Buffer.from('hi'));
  file.end();
  const body = w.bytes();
  const golden = goWrite(fields, 'xyz');
  assert.equal(hex(body), golden.bodyHex);
});

test('random boundary is 60 hex chars from getrandom, not Math.random', () => {
  const a = new MultipartWriter().boundary();
  const b = new MultipartWriter().boundary();
  assert.match(a, /^[0-9a-f]{60}$/);
  assert.match(b, /^[0-9a-f]{60}$/);
  assert.notEqual(a, b);
});
