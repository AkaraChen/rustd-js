import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  MailError, MailHeader, MailAddress, MailMessage, AddressParser,
  readMessage, parseAddress, parseAddressList, parseDate,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/mail.json', import.meta.url);

function go(args = []) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', '.', ...args], {
    cwd: resolve(root, 'packages/rustd-mail/gofixtures'),
    encoding: 'utf8',
    maxBuffer: 32 << 20,
    timeout: 120000,
    env: { ...process.env, GOWORK: 'off' },
  });
  if (result.error) throw result.error;
  return result;
}

function headerMap(msg) {
  const map = new Map();
  for (const key of msg.header.keys()) map.set(key, msg.header.values(key));
  return map;
}

function goHeaderMap(headers) {
  const map = new Map();
  for (const h of headers) map.set(h.key, h.values);
  return map;
}

test('Go regenerates committed mail fixtures; native parse matches', () => {
  const generated = go();
  assert.equal(generated.status, 0, generated.stderr);
  mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go mail fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'mail');
  assert.ok(packet.messages.length >= 10, `messages ${packet.messages.length}`);
  assert.ok(packet.addresses.length >= 20, `addresses ${packet.addresses.length}`);
  assert.ok(packet.dates.length >= 15, `dates ${packet.dates.length}`);

  for (const c of packet.messages) {
    const input = Buffer.from(c.inputHex, 'hex');
    if (c.error) {
      assert.throws(() => readMessage(input), (err) => {
        assert.equal(err instanceof MailError, true, `${c.id} class ${err}`);
        assert.match(err.message, /./, c.id);
        return true;
      }, c.id);
      continue;
    }
    const msg = readMessage(input);
    const bodyHex = c.bodyHex ?? '';
    assert.equal(Buffer.from(msg.body).toString('hex'), bodyHex, `${c.id} body`);
    if (c.bodySha256) {
      assert.equal(createHash('sha256').update(msg.body).digest('hex'), c.bodySha256, `${c.id} sha`);
    }
    const got = headerMap(msg);
    const want = goHeaderMap(c.headers);
    assert.equal(got.size, want.size, `${c.id} header count ${[...got.keys()]} vs ${[...want.keys()]}`);
    for (const [k, vs] of want) {
      assert.deepEqual(got.get(k), vs, `${c.id} header ${k}`);
    }
  }

  for (const c of packet.addresses) {
    if (c.error) {
      assert.throws(() => (c.list ? parseAddressList(c.input) : parseAddress(c.input)), (err) => {
        assert.equal(err instanceof MailError, true, `${c.id} class ${err}`);
        assert.equal(err.message, c.error, c.id);
        return true;
      }, c.id);
      continue;
    }
    const got = c.list ? parseAddressList(c.input) : [parseAddress(c.input)];
    assert.equal(got.length, c.results.length, `${c.id} count`);
    for (let i = 0; i < got.length; i++) {
      assert.equal(got[i].name, c.results[i].name, `${c.id}#${i} name`);
      assert.equal(got[i].address, c.results[i].address, `${c.id}#${i} address`);
      assert.equal(got[i].toString(), c.results[i].string, `${c.id}#${i} string`);
    }
  }

  for (const c of packet.dates) {
    if (c.error) {
      assert.throws(() => parseDate(c.input), (err) => {
        assert.equal(err instanceof MailError, true, `${c.id} class ${err}`);
        return true;
      }, c.id);
      continue;
    }
    const d = parseDate(c.input);
    assert.equal(d.getTime(), c.unixMs, `${c.id} unixMs got ${d.toISOString()} want ${c.rfc3339}`);
  }
});

test('MailHeader set/get/date/addressList and MailError kinds', () => {
  const h = new MailHeader({ from: ['a@b.com'], received: ['one', 'two'] });
  assert.equal(h.get('FROM'), 'a@b.com');
  assert.deepEqual(h.values('Received'), ['one', 'two']);
  h.set('Subject', 'Hi');
  assert.equal(h.get('subject'), 'Hi');
  h.setDate(new Date('1997-11-21T15:55:06Z'));
  assert.equal(h.get('Date'), 'Fri, 21 Nov 1997 15:55:06 +0000');
  assert.equal(h.date().toISOString(), '1997-11-21T15:55:06.000Z');
  assert.deepEqual(h.addressList('From').map((a) => a.address), ['a@b.com']);
  assert.throws(() => h.date() && new MailHeader().date(), (e) => e instanceof MailError && e.kind === 'header');
  assert.throws(() => parseAddress('not-an-address'), (e) => e instanceof MailError && e.kind === 'address' && e.code === 'MAIL');
  const parser = new AddressParser();
  assert.equal(parser.parse('a@b.com').address, 'a@b.com');
  const msg = readMessage('Content-Type: text/plain; charset=utf-8\n\nhello');
  assert.equal(msg instanceof MailMessage, true);
  assert.equal(msg.bodyText(), 'hello');
  assert.equal(msg.mediaType().type, 'text/plain');
  assert.equal(msg.mediaType().params.charset, 'utf-8');
  const named = new MailAddress('Jörg', 'joerg@example.com');
  assert.match(named.toString(), /joerg@example.com/);
});
