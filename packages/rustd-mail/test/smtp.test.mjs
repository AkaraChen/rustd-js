import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createHmac } from 'node:crypto';
import {
  SmtpError, SmtpClient,
  plainAuth, loginAuth, cramMd5Auth, sendMail,
} from '../index.mjs';
import { withFakeSmtp } from './smtp-fake.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/smtp.json', import.meta.url);
const testdata = resolve(root, 'tools/gofixtures/smtp');
const tlsCert = readFileSync(join(testdata, 'cert.pem'));
const tlsKey = readFileSync(join(testdata, 'key.pem'));
const tlsServer = { cert: tlsCert, key: tlsKey };
const tlsClient = { ca: tlsCert, serverName: '127.0.0.1' };
const sendMsg = 'From: test@example.com\r\nTo: other@example.com\r\nSubject: SendMail test\r\n\r\nSendMail is working for me.\r\n';
const dotMsg = 'From: user@gmail.com\nTo: golang-nuts@googlegroups.com\nSubject: Hooray for Go\n\nLine 1\n.Leading dot line .\nGoodbye.';
const lfMsg = 'From: a@b.com\nTo: c@d.com\n\nhello\n.world\nmixed\r\nline\n';

function goSmtp() {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', '.'], {
    cwd: resolve(root, 'tools/gofixtures/smtp'),
    encoding: 'utf8',
    maxBuffer: 32 << 20,
    timeout: 60000,
    env: { ...process.env, GOWORK: 'off' },
  });
  if (result.error) throw result.error;
  return result;
}

async function runTsCase(c, addr) {
  if (c.id === 'sendMail-ehlo-fail' || c.id === 'sendMail-ehlo-8bitmime') {
    await sendMail(addr, null, 'test@example.com', ['other@example.com'], sendMsg);
    return;
  }
  if (c.id === 'sendMail-multi-rcpt') {
    await sendMail(addr, null, 'a@b.com', ['one@b.com', 'two@b.com'], sendMsg);
    return;
  }
  if (c.id === 'client-starttls-auth') {
    const client = await SmtpClient.dial(addr);
    try {
      await client.startTls(tlsClient);
      await client.auth(plainAuth({ username: 'user', password: 'pass', host: '127.0.0.1' }));
      await client.mail('a@b.com');
      await client.rcpt('c@d.com');
      const w = await client.data();
      await w.write(sendMsg);
      await w.close();
      await client.quit();
    } finally {
      await client.close();
    }
    return;
  }
  if (c.id === 'sendMail-auth-plain') {
    await sendMail(addr, plainAuth({ username: 'user', password: 'pass', host: '127.0.0.1' }), 'a@b.com', ['c@d.com'], sendMsg);
    return;
  }
  if (c.id === 'sendMail-auth-unsupported') {
    await sendMail(addr, plainAuth({ username: 'user', password: 'pass', host: 'smtp.google.com' }), 'a@b.com', ['c@d.com'], sendMsg);
    return;
  }
  if (c.id === 'client-auth-fail') {
    const client = await SmtpClient.dial(addr);
    try {
      await client.auth(plainAuth({ username: 'user', password: 'pass', host: '127.0.0.1' }));
    } finally {
      await client.close();
    }
    return;
  }
  if (c.id === 'client-dot-stuff') {
    const client = await SmtpClient.dial(addr);
    try {
      await client.mail('user@gmail.com');
      await client.rcpt('golang-nuts@googlegroups.com');
      const w = await client.data();
      await w.write(dotMsg);
      await w.close();
      await client.quit();
    } finally {
      await client.close();
    }
    return;
  }
  if (c.id === 'client-lf-mixed') {
    const client = await SmtpClient.dial(addr);
    try {
      await client.mail('a@b.com');
      await client.rcpt('c@d.com');
      const w = await client.data();
      await w.write(lfMsg);
      await w.close();
      await client.quit();
    } finally {
      await client.close();
    }
    return;
  }
  if (c.id === 'mail-not-250') {
    const client = await SmtpClient.dial(addr);
    try {
      await client.mail('a@b.com');
    } catch (err) {
      await client.quit().catch(() => {});
      throw err;
    } finally {
      await client.close();
    }
    return;
  }
  if (c.id === 'rcpt-reject') {
    const client = await SmtpClient.dial(addr);
    try {
      await client.mail('a@b.com');
      await client.rcpt('ok@b.com');
      await assert.rejects(() => client.rcpt('bad@b.com'), SmtpError);
      await client.rcpt('ok2@b.com');
      const w = await client.data();
      await w.write(sendMsg);
      await w.close();
      await client.quit();
    } finally {
      await client.close();
    }
    return;
  }
  throw new Error(`unhandled case ${c.id}`);
}

test('Go regenerates committed smtp fixtures; TS client bytes match', async () => {
  const generated = goSmtp();
  assert.equal(generated.status, 0, generated.stderr + generated.stdout);
  mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go smtp fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'smtp');
  assert.ok(packet.cases.length >= 8, `cases ${packet.cases.length}`);

  for (const c of packet.cases) {
    if (c.kind === 'validate') {
      await assert.rejects(
        () => sendMail('127.0.0.1:1', null, 'a@b.com', ['b@c.com>\nDATA\n'], 'x'),
        (err) => err instanceof SmtpError && err.message === c.error,
      );
      continue;
    }
    let caught;
    const bytes = await withFakeSmtp({ ...c, tls: c.tls ? tlsServer : undefined }, async (addr) => {
      try {
        await runTsCase(c, addr);
      } catch (err) {
        caught = err;
      }
    }).catch((err) => {
      caught = caught ?? err;
      return Buffer.alloc(0);
    });
    const gotHex = Buffer.from(bytes).toString('hex');
    assert.equal(gotHex, c.clientHex, `${c.id} client bytes\nTS: ${Buffer.from(bytes).toString('utf8')}\nGo: ${Buffer.from(c.clientHex, 'hex').toString('utf8')}`);
    if (c.error) {
      assert.ok(caught, `${c.id} expected error ${c.error}`);
      assert.equal(caught.message, c.error, `${c.id} error text`);
    } else {
      assert.equal(caught, undefined, `${c.id} unexpected ${caught}`);
    }
  }
});

test('plainAuth refuses non-localhost without TLS and does not send the password', async () => {
  const recorded = await withFakeSmtp({
    banner: '220 example ESMTP',
    replies: ['250-example\n250 AUTH PLAIN', '221 bye'],
  }, async (addr) => {
    const client = await SmtpClient.dial(addr, { host: 'smtp.example.com' });
    await assert.rejects(
      () => client.auth(plainAuth({ username: 'user', password: 's3cret-password', host: 'smtp.example.com' })),
      (err) => err instanceof SmtpError && err.message === 'unencrypted connection',
    );
    await client.close();
  });
  const wire = recorded.toString('binary');
  assert.match(wire, /^EHLO localhost\r\nQUIT\r\n/);
  assert.equal(wire.includes('s3cret-password'), false);
  assert.equal(wire.includes('AUTH PLAIN'), false);
});

test('AUTH LOGIN challenge/response and AUTH PLAIN localhost', async () => {
  const user = Buffer.from('user').toString('base64');
  const pass = Buffer.from('pass').toString('base64');
  const recorded = await withFakeSmtp({
    banner: '220 localhost',
    replies: [
      '250-localhost\n250 AUTH LOGIN PLAIN',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '235 ok',
      '250 sender',
      '250 rcpt',
      '354 go',
      '250 data',
      '221 bye',
    ],
  }, async (addr) => {
    const client = await SmtpClient.dial(addr);
    await client.auth(loginAuth({ username: 'user', password: 'pass', host: '127.0.0.1' }));
    await client.mail('a@b.com');
    await client.rcpt('c@d.com');
    const w = await client.data();
    await w.write('Subject: x\r\n\r\nbody\r\n');
    await w.close();
    await client.quit();
  });
  const text = recorded.toString();
  assert.match(text, /^EHLO localhost\r\nAUTH LOGIN\r\n/);
  assert.match(text, new RegExp(`\r\n${user}\r\n${pass}\r\nMAIL FROM:<a@b.com>`));
});

test('STARTTLS handshake, re-EHLO, then AUTH; no plaintext password', async () => {
  const recorded = await withFakeSmtp({
    banner: '220 localhost',
    replies: [
      '250-localhost\n250-STARTTLS\n250 AUTH PLAIN',
      '220 ready',
      '250-localhost\n250 AUTH PLAIN',
      '235 ok',
      '250 sender',
      '250 rcpt',
      '354 go',
      '250 data',
      '221 bye',
    ],
    tls: tlsServer,
  }, async (addr) => {
    await sendMail(
      addr,
      plainAuth({ username: 'user', password: 'pass', host: '127.0.0.1' }),
      'a@b.com',
      ['c@d.com'],
      sendMsg,
      { tls: tlsClient },
    );
  });
  const text = recorded.toString();
  assert.match(text, /EHLO localhost\r\nSTARTTLS\r\nEHLO localhost\r\nAUTH PLAIN /);
  assert.match(text, /MAIL FROM:<a@b.com>/);
  const preTls = text.slice(0, text.indexOf('STARTTLS') + 'STARTTLS\r\n'.length);
  assert.equal(preTls.includes('AUTH PLAIN'), false);
  assert.equal(preTls.includes('pass'), false);
});

test('startTls sets tlsConnectionState and serverInfo.tls', async () => {
  await withFakeSmtp({
    banner: '220 localhost',
    replies: ['250-localhost\n250-STARTTLS\n250 AUTH PLAIN', '220 ready', '250 localhost', '221 bye'],
    tls: tlsServer,
  }, async (addr) => {
    const client = await SmtpClient.dial(addr);
    assert.equal(client.tlsConnectionState(), null);
    await client.startTls(tlsClient);
    assert.equal(client.serverInfo.tls, true);
    const st = client.tlsConnectionState();
    assert.equal(typeof st.protocol, 'string');
    assert.ok(st.protocol.startsWith('TLSv1.'));
    assert.equal(st.authorized, true);
    await client.quit();
  });
});

test('CRAM-MD5 next() matches Go hmac-md5 vector', () => {
  const auth = cramMd5Auth('user', 'pass');
  const started = auth.start({ name: 't', tls: true, auth: ['CRAM-MD5'] });
  assert.equal(started.proto, 'CRAM-MD5');
  const next = auth.next(Buffer.from('<123456.1322876914@testserver>'), true);
  assert.equal(Buffer.from(next).toString(), 'user 287eb355114cf5c471c26a875f1ca4ae');
  assert.equal(
    createHmac('md5', 'pass').update('<123456.1322876914@testserver>').digest('hex'),
    '287eb355114cf5c471c26a875f1ca4ae',
  );
});

test('DATA overlong line throws and is not truncated', async () => {
  await withFakeSmtp({
    banner: '220 localhost',
    replies: ['250 localhost', '250 sender', '250 rcpt', '354 go', '250 data', '221 bye'],
  }, async (addr) => {
    const client = await SmtpClient.dial(addr);
    await client.mail('a@b.com');
    await client.rcpt('c@d.com');
    const w = await client.data();
    await assert.rejects(() => w.write(`x${'y'.repeat(998)}\r\n`), (err) => (
      err instanceof SmtpError && /998/.test(err.message)
    ));
    await client.abandon();
  });
});

test('linux-x64 .node is under 2MB', () => {
  const dir = resolve(import.meta.dirname, '..');
  const binary = readdirSync(dir).find((f) => f.endsWith('.node') && f.startsWith('rustd-mail.'));
  assert.ok(binary, 'missing .node; build first');
  const bytes = statSync(join(dir, binary)).size;
  assert.ok(bytes <= 2_000_000, `${binary}: ${bytes} bytes exceeds 2000000`);
});
