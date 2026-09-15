import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import dgram from 'node:dgram';
import { hostname } from 'node:os';
import {
  setClock, formatLogCase, formatSlogCase, formatSyslogCase,
  Record, int, string, int64, float64, uint64, Logger, BadKeyError,
  FatalError, PanicError, info, newLoggerDefault, newTextHandler, setDefault,
  MessageTooLongError, syslogDial, syslogNew, SyslogError, UnsupportedPlatformError, LEVEL, FACILITY, SEVERITY,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO === 'path' ? [] : process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const bin = process.env.RUSTD_GO && process.env.RUSTD_GO !== 'path' ? process.env.RUSTD_GO : command;
  const result = spawnSync(bin, [...prefix, 'run', './tools/gofixtures/logdump', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 16 << 20, timeout: 120000,
  });
  if (result.error) throw result.error;
  return result;
}

test('Go regenerates log/slog/syslog bytes; native matches every case', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  const packet = JSON.parse(generated.stdout);
  assert.ok(packet.slog.length >= 80, `slog cases ${packet.slog.length}`);
  setClock(BigInt(packet.nowUnixNs));
  for (const c of packet.log) {
    assert.equal(Buffer.from(formatLogCase(c)).toString(), c.output, c.id);
  }
  for (const c of packet.slog) {
    assert.equal(Buffer.from(formatSlogCase(c, false)).toString(), c.text, `${c.id} text`);
    assert.equal(Buffer.from(formatSlogCase(c, true)).toString(), c.json, `${c.id} json`);
  }
  for (const c of packet.syslog) {
    assert.equal(Buffer.from(formatSyslogCase(c)).toString(), c.output, c.id);
  }
  const verified = go(['-verify'], generated.stdout);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ log/);
});

test('JSON does not HTML-escape (Go 1.24 slog SetEscapeHTML(false)) and keeps field order', () => {
  const generated = go();
  const packet = JSON.parse(generated.stdout);
  setClock(BigInt(packet.nowUnixNs));
  const html = packet.slog.find((c) => c.id === 'string-html');
  assert.match(html.json, /"<&>"/);
  assert.doesNotMatch(html.json, /\\u003c/);
  const bare = packet.slog.find((c) => c.id === 'bare');
  assert.match(bare.json, /^{"time":.*,"level":"INFO","msg":"hello"}\n$/);
});

test('Record Add/Attrs/NumAttrs/Clone', () => {
  const r = new Record(new Date(), LEVEL.Info, 'm', 0n);
  r.addAttrs(int('k1', 1), string('k2', 'foo'), int('k3', 3), int64('k4', -1n), float64('f', 3.1), uint64('u', 999n));
  assert.equal(r.numAttrs(), 6);
  assert.equal(r.attrs().length, 6);
  const c = r.clone();
  c.add('p', 2);
  assert.equal(r.numAttrs(), 6);
  assert.equal(c.numAttrs(), 7);
});

test('BadKeyError on odd rest args and non-string keys', () => {
  const chunks = [];
  const sink = { write(b) { chunks.push(Buffer.from(b)); return b.length; } };
  const log = newLoggerDefault(newTextHandler(sink));
  assert.throws(() => log.info('m', 'k'), BadKeyError);
  assert.throws(() => log.info('m', 1, 'v'), BadKeyError);
});

test('Fatal/Panic throw after writing and do not exit', () => {
  const chunks = [];
  const sink = { write(b) { chunks.push(Buffer.from(b)); return b.length; } };
  const log = new Logger(sink, '', 0);
  assert.throws(() => log.fatal('x'), FatalError);
  assert.throws(() => log.panic('y'), PanicError);
  assert.equal(Buffer.concat(chunks).toString(), 'x\ny\n');
});

test('sink short-write is retried until complete', () => {
  let n = 0;
  const got = [];
  const sink = {
    write(b) {
      n += 1;
      if (b.length > 1) {
        got.push(Buffer.from(b.subarray(0, 1)));
        return 1;
      }
      got.push(Buffer.from(b));
      return b.length;
    },
  };
  const log = new Logger(sink, '', 0);
  log.print('ab');
  assert.equal(Buffer.concat(got).toString(), 'ab\n');
  assert.ok(n >= 2);
});

const unixSyslogOnly = {
  skip: process.platform === 'win32' && 'syslog transport is explicitly unsupported on Windows; byte-formatting tests still run',
};

test('UDP syslog bytes match Go framing; oversized payload throws', unixSyslogOnly, async () => {
  const generated = go();
  const packet = JSON.parse(generated.stdout);
  setClock(BigInt(packet.nowUnixNs));
  const server = dgram.createSocket('udp4');
  const received = new Promise((resolve, reject) => {
    server.on('message', (msg) => resolve(Buffer.from(msg)));
    server.on('error', reject);
  });
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const priority = FACILITY.USER | SEVERITY.INFO;
  const tag = 'rustd';
  let w;
  try {
    w = syslogDial('udp', `127.0.0.1:${port}`, priority, tag);
    w.info('hello');
    const got = await received;
    const expect = formatSyslogCase({
      local: false, priority, hostname: hostname(), tag, pid: process.pid, msg: 'hello',
    });
    assert.equal(got.toString(), Buffer.from(expect).toString());
    assert.throws(() => w.info('x'.repeat(2000)), MessageTooLongError);
  } finally {
    w?.close();
    server.close();
  }
});

test('syslogNew either connects or throws a named Unix syslog error', unixSyslogOnly, () => {
  try {
    const w = syslogNew(FACILITY.USER | SEVERITY.INFO, 'rustd');
    w.close();
  } catch (err) {
    assert.equal(err.name, 'SyslogError');
    assert.match(String(err.message), /Unix syslog delivery error|log\/syslog/);
  }
});

if (process.platform === 'win32') {
  test('Windows syslog transports report UnsupportedPlatformError', () => {
    for (const call of [
      () => syslogDial('udp', '127.0.0.1:514', FACILITY.USER | SEVERITY.INFO, 'rustd'),
      () => syslogNew(FACILITY.USER | SEVERITY.INFO, 'rustd'),
    ]) {
      assert.throws(call, err => err instanceof UnsupportedPlatformError
        && err.code === 'ERR_LOG_UNSUPPORTED_PLATFORM'
        && err.message === 'log/syslog: not supported on Windows');
    }
  });
}

test('package slog info writes through the default handler after setDefault', () => {
  const chunks = [];
  const sink = { write(b) { chunks.push(Buffer.from(b)); return b.length; } };
  setDefault(newLoggerDefault(newTextHandler(sink, { level: LEVEL.Info })));
  info('hi', 'k', 1);
  assert.match(Buffer.concat(chunks).toString(), /msg=hi/);
});
