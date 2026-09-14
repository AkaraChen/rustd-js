import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { MultipartReader, MultipartWriter } from '../index.mjs';

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

function goRead(body, boundary) {
  const generated = go(['-multipart-read'], JSON.stringify({ boundary, bodyHex: hex(body) }));
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout);
}

function readAll(boundary, body) {
  const reader = new MultipartReader({ boundary });
  reader.write(body);
  const parts = [];
  for (;;) {
    const part = reader.nextPart();
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
