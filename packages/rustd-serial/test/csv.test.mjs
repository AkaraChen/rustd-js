import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { CsvReader, CsvWriter, CsvParseError, CsvEncodingError } from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/csv.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', '.', ...args], {
    cwd: resolve(root, 'packages/rustd-serial/gofixtures'),
    encoding: 'utf8',
    input,
    maxBuffer: 32 << 20,
    timeout: 120000,
    env: { ...process.env, GOWORK: 'off' },
  });
  if (result.error) throw result.error;
  return result;
}

function hex(data) {
  return Buffer.from(data).toString('hex');
}

function optsFrom(c) {
  const opts = { fieldsPerRecord: c.opts.fieldsPerRecord };
  if (c.opts.comma && c.opts.comma !== ',') opts.comma = c.opts.comma;
  if (c.opts.comment) opts.comment = c.opts.comment;
  if (c.opts.lazyQuotes) opts.lazyQuotes = true;
  if (c.opts.trimLeadingSpace) opts.trimLeadingSpace = true;
  return opts;
}

test('Go regenerates committed CSV fixtures; native read/write match', () => {
  const generated = go(['-pkg', 'serial-csv']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go CSV fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'serial-csv');
  assert.ok(packet.reads.length >= 40, `reads ${packet.reads.length}`);
  assert.ok(packet.writes.length >= 15, `writes ${packet.writes.length}`);

  for (const c of packet.reads) {
    const input = Buffer.from(c.inputHex, 'hex');
    const opts = optsFrom(c);
    if (c.delimErr) {
      assert.throws(() => new CsvReader(input, opts), TypeError, c.id);
      continue;
    }
    const reader = new CsvReader(input, opts);
    for (const [i, step] of (c.steps ?? []).entries()) {
      if (step.error) {
        assert.throws(() => reader.readBytes(), (err) => {
          assert.equal(err instanceof CsvParseError, true, `${c.id}#${i} class ${err}`);
          assert.equal(err.startLine, step.error.startLine, `${c.id} startLine`);
          assert.equal(err.line, step.error.line, `${c.id} line`);
          assert.equal(err.column, step.error.column, `${c.id} column`);
          assert.match(err.message, new RegExp(step.error.err.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        });
        break;
      }
      const row = reader.readBytes();
      assert.ok(row, `${c.id}#${i} eof`);
      assert.deepEqual(row.map(hex), step.fieldsHex, `${c.id}#${i} fields`);
      if (step.positions) {
        for (let f = 0; f < step.positions.length; f++) {
          const p = reader.fieldPos(f);
          assert.deepEqual([p.line, p.column], step.positions[f], `${c.id}#${i} pos ${f}`);
        }
      }
      assert.equal(reader.inputOffset(), step.offset, `${c.id}#${i} offset`);
    }
  }

  for (const c of packet.writes) {
    const wopts = {};
    if (c.useCRLF) wopts.useCRLF = true;
    if (c.comma) wopts.comma = c.comma;
    if (c.error) {
      assert.throws(() => {
        const w = new CsvWriter(wopts);
        w.writeAll(c.records);
      }, /invalid field or comment delimiter/, c.id);
      continue;
    }
    const w = new CsvWriter(wopts);
    w.writeAll(c.records);
    assert.equal(hex(w.bytes()), c.outputHex, c.id);
    assert.equal(w.error(), null, c.id);
  }
});

test('JS-generated CSV bytes verify against Go', () => {
  const w = new CsvWriter();
  w.writeAll([
    ['abc', 'def'],
    ['a"b', ' x'],
    ['multi\nline', ''],
    ['\\.'] ,
  ]);
  const crlf = new CsvWriter({ useCRLF: true });
  crlf.writeAll([['abc\ndef'], ['a', 'b']]);
  const pipe = new CsvWriter({ comma: '|' });
  pipe.writeAll([['a', 'a', '']]);
  const packet = {
    schema: 1,
    package: 'serial-csv',
    writes: [
      { id: 'js-basic', records: [['abc', 'def'], ['a"b', ' x'], ['multi\nline', ''], ['\\.']], outputHex: hex(w.bytes()) },
      { id: 'js-crlf', records: [['abc\ndef'], ['a', 'b']], useCRLF: true, outputHex: hex(crlf.bytes()) },
      { id: 'js-pipe', records: [['a', 'a', '']], comma: '|', outputHex: hex(pipe.bytes()) },
    ],
  };
  const verified = go(['-pkg', 'serial-csv', '-verify'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 3 serial-csv write cases/);
});

test('read() rejects invalid UTF-8; readBytes keeps Go bytes', () => {
  const input = Buffer.from('x09A\xb4\x1c,aktau', 'latin1');
  assert.throws(() => new CsvReader(input, { fieldsPerRecord: -1 }).read(), CsvEncodingError);
  const fields = new CsvReader(input, { fieldsPerRecord: -1 }).readBytes();
  assert.equal(hex(fields[0]), hex(Buffer.from('x09A\xb4\x1c', 'latin1')));
  assert.equal(Buffer.from(fields[1]).toString(), 'aktau');
});

test('ReuseRecord is not implemented; each read returns a new array', () => {
  const r = new CsvReader(Buffer.from('a,b\nc,d\n'), { fieldsPerRecord: -1 });
  const a = r.read();
  const b = r.read();
  assert.notEqual(a, b);
  a[0] = 'mut';
  assert.equal(b[0], 'c');
});

test('canonical round-trip Write(Read(csv)) matches byte-for-byte', () => {
  const canonical = Buffer.from('a,b,c\n"d,e",f,"g""h"\n');
  const rows = new CsvReader(canonical, { fieldsPerRecord: -1 }).readAll();
  const w = new CsvWriter();
  w.writeAll(rows);
  assert.equal(hex(w.bytes()), hex(canonical));
});

test('Python csv reads native writer output', () => {
  const w = new CsvWriter();
  w.writeAll([['name', 'n'], ['a,b', '1'], ['x"y', '2']]);
  const py = spawnSync('python3', ['-c', `
import csv, sys
rows = list(csv.reader(sys.stdin.read().splitlines()))
assert rows == [['name', 'n'], ['a,b', '1'], ['x"y', '2']], rows
print('python csv ok', len(rows))
`], { input: Buffer.from(w.bytes()), encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.match(py.stdout, /python csv ok 3/);
});

test('1 MiB file parses without throw; empty/NUL/long field edges', () => {
  const lines = [];
  for (let i = 0; i < 1024; i++) lines.push(`${'x'.repeat(1024)},${i}`);
  const big = Buffer.from(lines.join('\n'));
  assert.ok(big.length > 1_000_000);
  const rows = new CsvReader(big, { fieldsPerRecord: -1 }).readAll();
  assert.equal(rows.length, 1024);
  assert.equal(rows[1023][1], '1023');

  assert.deepEqual(new CsvReader(new Uint8Array(), { fieldsPerRecord: -1 }).readAll(), []);
  assert.deepEqual(new CsvReader(Buffer.from('\n\n'), { fieldsPerRecord: -1 }).readAll(), []);
  const nul = new CsvReader(Buffer.from('a\x00b,c\n'), { fieldsPerRecord: -1 }).readBytes();
  assert.equal(nul[0][1], 0);

  const long = Buffer.from(`"${'y'.repeat(1 << 20)}",z\n`);
  const one = new CsvReader(long, { fieldsPerRecord: -1 }).read();
  assert.equal(one[0].length, 1 << 20);
});

test('fieldPos out of range and slice independence', () => {
  const src = Buffer.from('a,b\n');
  const slice = src.subarray(0, 4);
  const r = new CsvReader(slice, { fieldsPerRecord: -1 });
  const row = r.read();
  assert.deepEqual(row, ['a', 'b']);
  slice[0] = 90;
  assert.equal(row[0], 'a');
  assert.throws(() => r.fieldPos(9), RangeError);
  assert.throws(() => r.fieldPos(-1), RangeError);
});
