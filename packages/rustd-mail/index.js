'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const name = 'rustd-mail';
let platform = `${process.platform}-${process.arch}`;
if (process.platform === 'linux') {
  if (!process.report.getReport().header.glibcVersionRuntime) {
    throw new Error(`${name}: Linux musl is not supported`);
  }
  platform += '-gnu';
} else if (process.platform === 'win32') platform += '-msvc';
if (!['darwin-arm64', 'darwin-x64', 'linux-x64-gnu', 'linux-arm64-gnu', 'win32-x64-msvc'].includes(platform)) {
  throw new Error(`${name}: unsupported platform ${platform}`);
}
const local = join(__dirname, `${name}.${platform}.node`);
const binding = existsSync(local) ? require(local) : require(`${name}-${platform}`);

class MailError extends Error {
  constructor(message, kind, options) {
    super(message, options);
    this.name = 'MailError';
    this.code = 'MAIL';
    this.kind = kind;
  }
}

function wrap(kind, fn) {
  try {
    return fn();
  } catch (cause) {
    const raw = cause && typeof cause.message === 'string' ? cause.message : String(cause);
    const sep = raw.indexOf('|');
    if (sep > 0) {
      const mapped = raw.slice(0, sep);
      const message = raw.slice(sep + 1);
      throw new MailError(message, mapped, { cause });
    }
    throw new MailError(raw, kind, { cause });
  }
}

function bytes(value) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') {
    throw new TypeError('mail: expected Uint8Array');
  }
  return value;
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });

function inputBytes(value) {
  return typeof value === 'string' ? encoder.encode(value) : bytes(value);
}

function requireString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`mail: ${label} must be a string`);
  return value;
}

class MailAddress {
  constructor(name, address) {
    this.name = requireString(name, 'name');
    this.address = requireString(address, 'address');
    Object.freeze(this);
  }
  toString() {
    return wrap('address', () => binding.formatAddress(this.name, this.address));
  }
}

function toAddress(obj) {
  return new MailAddress(obj.name, obj.address);
}

class MailHeader {
  constructor(init) {
    this._keys = [];
    this._map = new Map();
    if (init === undefined) return;
    if (init === null || typeof init !== 'object' || Array.isArray(init)) {
      throw new TypeError('mail: header init must be an object');
    }
    for (const [key, values] of Object.entries(init)) {
      if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) {
        throw new TypeError('mail: header values must be string[]');
      }
      const canon = wrap('header', () => binding.canonicalHeaderKey(key));
      if (!this._map.has(canon)) this._keys.push(canon);
      this._map.set(canon, values.slice());
    }
  }
  get(key) {
    const values = this.values(key);
    return values.length ? values[0] : '';
  }
  values(key) {
    const canon = wrap('header', () => binding.canonicalHeaderKey(requireString(key, 'key')));
    const values = this._map.get(canon);
    return values ? values.slice() : [];
  }
  set(key, value) {
    const canon = wrap('header', () => binding.canonicalHeaderKey(requireString(key, 'key')));
    requireString(value, 'value');
    if (!this._map.has(canon)) this._keys.push(canon);
    this._map.set(canon, [value]);
  }
  date() {
    const hdr = this.get('Date');
    if (hdr === '') throw new MailError('mail: header not in message', 'header');
    return parseDate(hdr);
  }
  setDate(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
      throw new TypeError('mail: setDate requires a valid Date');
    }
    this.set('Date', wrap('date', () => binding.formatDate(d.getTime())));
  }
  addressList(key) {
    const hdr = this.get(key);
    if (hdr === '') throw new MailError('mail: header not in message', 'header');
    return parseAddressList(hdr);
  }
  keys() {
    return this._keys.slice();
  }
}

function headerFromPairs(pairs) {
  const header = new MailHeader();
  for (const pair of pairs) {
    if (!header._map.has(pair.key)) header._keys.push(pair.key);
    const list = header._map.get(pair.key) ?? [];
    list.push(pair.value);
    header._map.set(pair.key, list);
  }
  return header;
}

class MailMessage {
  constructor(header, body, raw) {
    this.header = header;
    this.body = body;
    this.raw = raw;
    Object.freeze(this);
  }
  mediaType() {
    const ct = this.header.get('Content-Type');
    if (ct === '') return { type: 'text/plain', params: { charset: 'us-ascii' } };
    const parsed = wrap('syntax', () => binding.parseMediaType(ct));
    return { type: parsed.type, params: parsed.params };
  }
  bodyText() {
    const { params } = this.mediaType();
    const charset = (params.charset ?? 'us-ascii').toLowerCase();
    if (charset === 'utf-8' || charset === 'us-ascii' || charset === 'ascii') {
      try {
        return utf8.decode(this.body);
      } catch (cause) {
        throw new MailError('mail: body is not valid utf-8', 'syntax', { cause });
      }
    }
    if (charset === 'iso-8859-1' || charset === 'latin1') {
      return Buffer.from(this.body).toString('latin1');
    }
    throw new MailError(`mail: unhandled charset ${JSON.stringify(charset)}`, 'syntax');
  }
}

function readMessage(input) {
  const data = inputBytes(input);
  const msg = wrap('header', () => binding.readMessage(data));
  return new MailMessage(headerFromPairs(msg.headers), msg.body, msg.raw);
}

function parseAddress(s) {
  return toAddress(wrap('address', () => binding.parseAddress(requireString(s, 'address'))));
}

function parseAddressList(s) {
  const list = wrap('address', () => binding.parseAddressList(requireString(s, 'address list')));
  return list.map(toAddress);
}

function parseDate(s) {
  const ms = wrap('date', () => binding.parseDate(requireString(s, 'date')));
  return new Date(ms);
}

class AddressParser {
  parse(s) {
    return parseAddress(s);
  }
  parseList(s) {
    return parseAddressList(s);
  }
}

class SmtpError extends Error {
  constructor(message, init = {}) {
    super(message, init.cause ? { cause: init.cause } : undefined);
    this.name = 'SmtpError';
    this.code = init.code ?? 0;
    this.command = init.command ?? '';
    this.serverMessage = init.serverMessage ?? '';
    this.permanent = this.code >= 500;
  }
}

class FeatureNotBuiltError extends SmtpError {
  constructor(message, init = {}) {
    super(message, init);
    this.name = 'FeatureNotBuiltError';
  }
}

function asciiTrim(s) {
  return s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

function splitHostPort(address) {
  if (address.startsWith('[')) {
    const end = address.indexOf(']');
    if (end > 0) return address.slice(1, end);
  }
  const i = address.lastIndexOf(':');
  return i === -1 ? address : address.slice(0, i);
}

function isLocalhost(name) {
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function validateLine(line) {
  if (line.includes('\n') || line.includes('\r')) {
    throw new SmtpError('smtp: A line must not contain CR or LF', { command: '' });
  }
}

function requireSmtpAuth(value) {
  if (!value || typeof value.start !== 'function' || typeof value.next !== 'function') {
    throw new TypeError('smtp: auth must implement start/next');
  }
  return value;
}

function mapSmtpCause(cause, command) {
  const raw = cause && typeof cause.message === 'string' ? cause.message : String(cause);
  if (raw.startsWith('smtp|')) {
    const parts = raw.split('|');
    const code = Number(parts[1] || 0);
    const cmd = parts[2] || command;
    const serverMessage = parts.slice(3, -1).join('|');
    const kind = parts[parts.length - 1];
    const message = kind === 'response' ? `${String(code).padStart(3, '0')} ${serverMessage}` : serverMessage;
    if (kind === 'feature') return new FeatureNotBuiltError(message, { code, command: cmd, serverMessage, cause });
    return new SmtpError(message, { code, command: cmd, serverMessage, cause });
  }
  if (cause instanceof SmtpError) {
    if (!cause.command && command) cause.command = command;
    return cause;
  }
  return new SmtpError(raw, { command, cause });
}

async function smtpCall(command, promise) {
  try {
    return await promise;
  } catch (cause) {
    throw mapSmtpCause(cause, command);
  }
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function unb64(s) {
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

function toBytes(value) {
  return typeof value === 'string' ? encoder.encode(value) : bytes(value);
}

function plainAuth(opts) {
  if (opts === null || typeof opts !== 'object') throw new TypeError('smtp: plainAuth options required');
  const identity = opts.identity == null ? '' : requireString(opts.identity, 'identity');
  const username = requireString(opts.username, 'username');
  const password = requireString(opts.password, 'password');
  const host = requireString(opts.host, 'host');
  return {
    start(server) {
      if (!server.tls && !isLocalhost(server.name)) {
        throw new SmtpError('unencrypted connection', { command: 'AUTH' });
      }
      if (server.name !== host) {
        throw new SmtpError('wrong host name', { command: 'AUTH' });
      }
      return { proto: 'PLAIN', initial: encoder.encode(`${identity}\0${username}\0${password}`) };
    },
    next(_fromServer, more) {
      if (more) throw new SmtpError('unexpected server challenge', { command: 'AUTH' });
      return null;
    },
  };
}

function loginAuth(opts) {
  if (opts === null || typeof opts !== 'object') throw new TypeError('smtp: loginAuth options required');
  const username = requireString(opts.username, 'username');
  const password = requireString(opts.password, 'password');
  const host = requireString(opts.host, 'host');
  let step = 0;
  return {
    start(server) {
      if (!server.tls && !isLocalhost(server.name)) {
        throw new SmtpError('unencrypted connection', { command: 'AUTH' });
      }
      if (server.name !== host) {
        throw new SmtpError('wrong host name', { command: 'AUTH' });
      }
      step = 0;
      return { proto: 'LOGIN', initial: new Uint8Array(0) };
    },
    next(_fromServer, more) {
      if (!more) return null;
      if (step === 0) {
        step = 1;
        return encoder.encode(username);
      }
      if (step === 1) {
        step = 2;
        return encoder.encode(password);
      }
      throw new SmtpError('unexpected server challenge', { command: 'AUTH' });
    },
  };
}

function cramMd5Auth(username, secret) {
  const user = requireString(username, 'username');
  const sec = requireString(secret, 'secret');
  const { createHmac } = require('node:crypto');
  return {
    start() {
      return { proto: 'CRAM-MD5', initial: new Uint8Array(0) };
    },
    next(fromServer, more) {
      if (!more) return null;
      const digest = createHmac('md5', sec).update(fromServer).digest('hex');
      return encoder.encode(`${user} ${digest}`);
    },
  };
}

class SmtpDataWriter {
  constructor(client) {
    this._client = client;
    this._closed = false;
  }
  async write(chunk) {
    if (this._closed) throw new SmtpError('smtp: data writer closed', { command: 'DATA' });
    await smtpCall('DATA', binding.smtpDotWrite(this._client._id, toBytes(chunk)));
  }
  async close() {
    if (this._closed) return;
    this._closed = true;
    await smtpCall('DATA', binding.smtpDotClose(this._client._id));
    await this._client._readResponse(250, 'DATA');
  }
}

class SmtpClient {
  constructor(id, serverName) {
    this._id = id;
    this._serverName = serverName;
    this._tls = false;
    this._ext = null;
    this._auth = [];
    this._localName = 'localhost';
    this._didHello = false;
    this._helloError = null;
    this._closed = false;
  }

  static async dial(address, opts = {}) {
    const addr = requireString(address, 'address');
    const host = opts.host == null ? splitHostPort(addr) : requireString(opts.host, 'host');
    const timeoutMs = opts.timeoutMs == null ? 30000 : opts.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('smtp: timeoutMs must be a number');
    const id = await smtpCall('DIAL', binding.smtpDial(addr, timeoutMs >>> 0));
    const client = new SmtpClient(id, host);
    try {
      await client._readResponse(220, '');
      return client;
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }

  get serverInfo() {
    return { name: this._serverName, tls: this._tls, auth: this._auth.slice() };
  }

  async _writeLine(line) {
    this._ensureOpen();
    await smtpCall(line.split(/[ ]/, 1)[0], binding.smtpWriteLine(this._id, line));
  }

  async _readResponse(expect, command) {
    this._ensureOpen();
    try {
      return await binding.smtpReadResponse(this._id, expect);
    } catch (cause) {
      throw mapSmtpCause(cause, command);
    }
  }

  async _cmd(expect, line) {
    const command = line.split(/[ ]/, 1)[0];
    await this._writeLine(line);
    return this._readResponse(expect, command);
  }

  _ensureOpen() {
    if (this._closed) throw new SmtpError('smtp: connection closed', { command: '' });
  }

  async _hello() {
    if (!this._didHello) {
      this._didHello = true;
      try {
        await this._ehlo();
      } catch {
        try {
          await this._helo();
          this._helloError = null;
        } catch (err) {
          this._helloError = err;
        }
      }
    }
    if (this._helloError) throw this._helloError;
  }

  async _helo() {
    this._ext = null;
    this._auth = [];
    await this._cmd(250, `HELO ${this._localName}`);
  }

  async _ehlo() {
    const { message } = await this._cmd(250, `EHLO ${this._localName}`);
    const ext = Object.create(null);
    const lines = message.split('\n');
    if (lines.length > 1) {
      for (const line of lines.slice(1)) {
        const sp = line.indexOf(' ');
        const k = sp === -1 ? line : line.slice(0, sp);
        const v = sp === -1 ? '' : line.slice(sp + 1);
        ext[k] = v;
      }
    }
    if (Object.prototype.hasOwnProperty.call(ext, 'AUTH')) {
      this._auth = ext.AUTH === '' ? [] : ext.AUTH.split(' ');
    } else {
      this._auth = [];
    }
    this._ext = ext;
  }

  async hello(localName) {
    if (localName !== undefined) {
      requireString(localName, 'localName');
      validateLine(localName);
    }
    if (this._didHello) throw new SmtpError('smtp: Hello called after other methods', { command: 'EHLO' });
    if (localName !== undefined) this._localName = localName;
    await this._hello();
  }

  async auth(a) {
    requireSmtpAuth(a);
    await this._hello();
    let proto;
    let initial;
    try {
      const started = a.start(this.serverInfo);
      proto = requireString(started.proto, 'proto');
      initial = started.initial == null ? new Uint8Array(0) : toBytes(started.initial);
    } catch (err) {
      await this.quit().catch(() => {});
      throw mapSmtpCause(err, 'AUTH');
    }
    let resp64 = b64(initial);
    let line = asciiTrim(`AUTH ${proto} ${resp64}`);
    let { code, message: msg64 } = await this._cmd(0, line);
    let err = null;
    for (;;) {
      let msg;
      if (err == null) {
        if (code === 334) {
          try {
            msg = unb64(msg64);
          } catch (e) {
            err = e;
          }
        } else if (code === 235) {
          msg = encoder.encode(msg64);
        } else {
          err = new SmtpError(`${String(code).padStart(3, '0')} ${msg64}`, {
            code,
            command: 'AUTH',
            serverMessage: msg64,
          });
        }
      }
      let resp = null;
      if (err == null) {
        try {
          resp = a.next(msg, code === 334);
          if (resp === undefined) resp = null;
        } catch (e) {
          err = e;
        }
      }
      if (err != null) {
        await this._cmd(501, '*').catch(() => {});
        await this.quit().catch(() => {});
        throw mapSmtpCause(err, 'AUTH');
      }
      if (resp == null) break;
      resp64 = b64(toBytes(resp));
      ({ code, message: msg64 } = await this._cmd(0, resp64));
    }
  }

  async mail(from) {
    requireString(from, 'from');
    validateLine(from);
    await this._hello();
    let cmd = `MAIL FROM:<${from}>`;
    if (this._ext) {
      if (Object.prototype.hasOwnProperty.call(this._ext, '8BITMIME')) cmd += ' BODY=8BITMIME';
      if (Object.prototype.hasOwnProperty.call(this._ext, 'SMTPUTF8')) cmd += ' SMTPUTF8';
    }
    await this._cmd(250, cmd);
  }

  async rcpt(to) {
    requireString(to, 'to');
    validateLine(to);
    await this._cmd(25, `RCPT TO:<${to}>`);
  }

  async data() {
    await this._cmd(354, 'DATA');
    return new SmtpDataWriter(this);
  }

  async reset() {
    await this._hello();
    await this._cmd(250, 'RSET');
  }

  async noop() {
    await this._hello();
    await this._cmd(250, 'NOOP');
  }

  async verify(addr) {
    requireString(addr, 'addr');
    validateLine(addr);
    await this._hello();
    await this._cmd(250, `VRFY ${addr}`);
  }

  extension(ext) {
    if (!this._didHello) return false;
    if (!this._ext) return false;
    return Object.prototype.hasOwnProperty.call(this._ext, String(ext).toUpperCase());
  }

  extensionParams(ext) {
    if (!this._didHello || !this._ext) return '';
    const key = String(ext).toUpperCase();
    return Object.prototype.hasOwnProperty.call(this._ext, key) ? this._ext[key] : '';
  }

  async startTls() {
    await this._hello();
    await this._cmd(220, 'STARTTLS');
    throw new FeatureNotBuiltError('smtp: STARTTLS handshake not built', {
      command: 'STARTTLS',
      serverMessage: 'rustd-tls cancelled; refusing plaintext continuation',
    });
  }

  tlsConnectionState() {
    return null;
  }

  async quit() {
    try {
      await this._hello();
    } catch {
      // Go ignores hello error while quitting.
    }
    try {
      await this._cmd(221, 'QUIT');
    } finally {
      await this.close();
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    await smtpCall('', binding.smtpClose(this._id)).catch(() => {});
  }

  async abandon() {
    await this.close();
  }

  async [Symbol.asyncDispose]() {
    if (!this._closed) await this.quit().catch(() => this.close());
  }
}

async function sendMail(address, auth, from, to, msg, opts) {
  requireString(from, 'from');
  validateLine(from);
  if (!Array.isArray(to) || to.some((x) => typeof x !== 'string')) {
    throw new TypeError('smtp: to must be string[]');
  }
  for (const recp of to) validateLine(recp);
  const client = await SmtpClient.dial(address, opts);
  try {
    await client._hello();
    if (client.extension('STARTTLS')) {
      await client.startTls();
    }
    if (auth != null) {
      requireSmtpAuth(auth);
      if (!client.extension('AUTH')) {
        throw new SmtpError("smtp: server doesn't support AUTH", { command: 'AUTH' });
      }
      await client.auth(auth);
    }
    await client.mail(from);
    for (const recp of to) await client.rcpt(recp);
    const writer = await client.data();
    await writer.write(msg);
    await writer.close();
    await client.quit();
  } finally {
    await client.close();
  }
}

module.exports = {
  MailError,
  MailHeader,
  MailAddress,
  MailMessage,
  AddressParser,
  readMessage,
  parseAddress,
  parseAddressList,
  parseDate,
  SmtpError,
  FeatureNotBuiltError,
  SmtpClient,
  SmtpDataWriter,
  plainAuth,
  loginAuth,
  cramMd5Auth,
  sendMail,
};
