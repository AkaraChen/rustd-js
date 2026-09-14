import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  parseMediaType, formatMediaType, InvalidMediaParameterError, MediaTypeError,
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

function parseNative(input) {
  try {
    const { mediaType, params } = parseMediaType(input);
    return { mediaType, params, error: '' };
  } catch (err) {
    if (err instanceof InvalidMediaParameterError) {
      return { mediaType: err.mediaType, params: err.params, error: err.message };
    }
    if (err instanceof MediaTypeError) {
      return { mediaType: '', params: {}, error: err.message };
    }
    throw err;
  }
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()));
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });
}

function curlAsync(args, timeoutMs = 10000) {
  return new Promise((resolveCurl, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`curl timeout: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveCurl({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

test('curl -H Content-Type is preserved on the wire and matches parseMediaType + Go', async () => {
  const curlCheck = spawnSync('curl', ['--version'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(curlCheck.status, 0, curlCheck.stderr);

  const cases = [
    'text/plain',
    'text/plain; charset=utf-8',
    'TEXT/HTML; charset=UTF-8',
    'application/json',
    'application/json; charset=utf-8',
    'application/octet-stream',
    'application/x-www-form-urlencoded',
    'image/png',
    'text/html; charset=iso-8859-1',
    'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW',
    'application/x-stuff; title="This is fun"',
    'attachment; filename="robots.txt"',
    formatMediaType('text/plain', { charset: 'utf-8' }),
    formatMediaType('multipart/form-data', { boundary: '----WebKitFormBoundary7MA4YWxkTrZu0gW' }),
    formatMediaType('application/x-stuff', { title: 'This is fun€' }),
  ];

  const server = createServer((req, res) => {
    const ct = req.headers['content-type'] ?? '';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(ct);
  });
  const addr = await listen(server);
  const url = `http://127.0.0.1:${addr.port}/probe`;
  const parse = [];
  try {
    for (const header of cases) {
      const curl = await curlAsync([
        '-sS', '--fail', '--noproxy', '*',
        '-H', `Content-Type: ${header}`,
        '--data-binary', 'x',
        url,
      ]);
      assert.equal(curl.status, 0, `${header}: ${curl.stderr}`);
      const wire = curl.stdout;
      assert.equal(wire, header, `curl/http preserved ${JSON.stringify(header)}`);
      const native = parseNative(wire);
      assert.deepEqual(native, parseNative(header), `native parse of wire ${header}`);
      parse.push({ in: wire, ...native });
    }
  } finally {
    await close(server);
  }

  assert.ok(parse.length >= 12, `curl cases ${parse.length}`);
  const packet = { schema: 1, package: 'mime', parse, qpEnc: [], qpDec: [], words: [], format: [], headers: [] };
  const verified = go(['-verify'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified \d+ mime cases/);
  const broken = structuredClone(packet);
  broken.parse[0].mediaType = 'not-the-type';
  const rejected = go(['-verify'], JSON.stringify(broken));
  assert.notEqual(rejected.status, 0);
});
