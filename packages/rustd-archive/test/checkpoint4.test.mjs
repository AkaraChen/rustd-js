import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tarExtract, zipCreate, zipExtract } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');

function go(args, input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const prefix = command === 'go' ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', ...args], {
    cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Go exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function loadFixtures() {
  return JSON.parse(go(['-pkg', 'archive']));
}

function byId(packet, id) {
  const found = packet.cases.find((c) => c.id === id);
  assert.ok(found, `missing fixture ${id}`);
  return found;
}

function bytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function equalBytes(a, b, label) {
  assert.equal(a.length, b.length, label);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `${label}[${i}]`);
}

test('Go tar-symlink/hardlink/fifo: type and linkname match Go listings', () => {
  const packet = loadFixtures();
  const symlink = byId(packet, 'tar-symlink');
  const hardlink = byId(packet, 'tar-hardlink');
  const fifo = byId(packet, 'tar-fifo');

  const gotSym = tarExtract(bytes(symlink.archiveHex));
  assert.equal(gotSym.length, 2);
  assert.equal(gotSym[0].name, 'target');
  assert.equal(gotSym[0].type, 'reg');
  equalBytes(gotSym[0].data, bytes(symlink.entries[0].dataHex), 'symlink target');
  assert.equal(gotSym[1].name, 'link');
  assert.equal(gotSym[1].type, 'symlink');
  assert.equal(gotSym[1].linkname, 'target');
  assert.equal(gotSym[1].linkname, symlink.entries[1].linkname);

  const gotHard = tarExtract(bytes(hardlink.archiveHex));
  assert.equal(gotHard[1].type, 'hardlink');
  assert.equal(gotHard[1].linkname, 'orig');
  assert.equal(gotHard[1].linkname, hardlink.entries[1].linkname);

  const gotFifo = tarExtract(bytes(fifo.archiveHex));
  assert.equal(gotFifo.length, 1);
  assert.equal(gotFifo[0].name, 'pipe');
  assert.equal(gotFifo[0].type, 'fifo');
});

test('Go zip-comment: entry comment round-trips; data matches', () => {
  const packet = loadFixtures();
  const c = byId(packet, 'zip-comment');
  const got = zipExtract(bytes(c.archiveHex));
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'c.txt');
  assert.equal(got[0].comment, 'entry');
  assert.equal(got[0].comment, c.entries[0].comment);
  equalBytes(got[0].data, bytes(c.entries[0].dataHex), 'zip-comment data');
});

test('Go zip-zip64-crafted: extract name and payload (zip64 extra, not 4GiB)', () => {
  const packet = loadFixtures();
  const c = byId(packet, 'zip-zip64-crafted');
  const got = zipExtract(bytes(c.archiveHex));
  assert.equal(got.length, 1, c.id);
  assert.equal(got[0].name, 'z64.txt');
  assert.equal(got[0].name, c.entries[0].name);
  equalBytes(got[0].data, bytes(c.entries[0].dataHex), 'zip64 payload');
  assert.equal(Buffer.from(got[0].data).toString(), 'zip64');
});

test('non-UTF8 zip names keep rawName and set nonUtf8; name is not a silent replacement of the bytes', () => {
  const rawName = Uint8Array.from([0xff, 0xfe, 0x41, 0x2e, 0x74, 0x78, 0x74]);
  const data = new TextEncoder().encode('raw');
  const zip = zipCreate([{ name: 'ignored.txt', method: 0, data, nonUtf8: true, rawName }]);
  const got = zipExtract(zip);
  assert.equal(got.length, 1);
  assert.equal(got[0].nonUtf8, true);
  assert.ok(got[0].rawName instanceof Uint8Array, 'rawName must be present');
  equalBytes(got[0].rawName, rawName, 'rawName');
  // Lossy UTF-8 view must not be treated as the stored name.
  assert.notDeepEqual(Array.from(new TextEncoder().encode(got[0].name)), Array.from(rawName));
});
