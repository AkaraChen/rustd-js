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
};
