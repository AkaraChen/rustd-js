'use strict';
const { existsSync, openSync, writeSync, closeSync } = require('node:fs');
const { join } = require('node:path');
const dgram = require('node:dgram');
const net = require('node:net');
const name = 'rustd-log';
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

class LogError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = new.target.code;
  }
  static code = 'ERR_LOG';
}
class BadKeyError extends LogError { static code = 'ERR_LOG_BAD_KEY'; }
class FatalError extends LogError { static code = 'ERR_LOG_FATAL'; }
class PanicError extends LogError { static code = 'ERR_LOG_PANIC'; }
class MessageTooLongError extends LogError { static code = 'ERR_LOG_MESSAGE_TOO_LONG'; }
class UnsupportedPlatformError extends LogError { static code = 'ERR_LOG_UNSUPPORTED_PLATFORM'; }
class SyslogError extends LogError { static code = 'ERR_LOG_SYSLOG'; }

const L = Object.freeze({
  Date: 1, Time: 2, Microseconds: 4, LongFile: 8, ShortFile: 16, UTC: 32, MsgPrefix: 64,
  StdFlags: 1 | 2,
});
const LEVEL = Object.freeze({ Debug: -4, Info: 0, Warn: 4, Error: 8 });
const KIND = Object.freeze({ Any: 0, Bool: 1, Duration: 2, Float64: 3, Int64: 4, String: 5, Time: 6, Uint64: 7, Group: 8, LogValuer: 9 });
const TIME_KEY = 'time';
const LEVEL_KEY = 'level';
const MESSAGE_KEY = 'msg';
const SOURCE_KEY = 'source';
const FACILITY = Object.freeze({
  KERN: 0, USER: 8, MAIL: 16, DAEMON: 24, AUTH: 32, SYSLOG: 40, LPR: 48, NEWS: 56,
  UUCP: 64, CRON: 72, AUTHPRIV: 80, FTP: 88,
  LOCAL0: 128, LOCAL1: 136, LOCAL2: 144, LOCAL3: 152, LOCAL4: 160, LOCAL5: 168, LOCAL6: 176, LOCAL7: 184,
});
const SEVERITY = Object.freeze({
  EMERG: 0, ALERT: 1, CRIT: 2, ERR: 3, WARNING: 4, NOTICE: 5, INFO: 6, DEBUG: 7,
});

let clockNs = null;
function setClock(ns) { clockNs = ns == null ? null : BigInt(ns); }
function nowNs() { return clockNs ?? BigInt(Date.now()) * 1_000_000n; }
function nowDate() { return new Date(Number(nowNs() / 1_000_000n)); }
function splitNs(ns) {
  const n = BigInt(ns);
  const den = 1_000_000_000n;
  let secs = n / den;
  let nsec = n % den;
  if (nsec < 0n) { secs -= 1n; nsec += den; }
  return [Number(secs), Number(nsec)];
}

function native(fn) {
  try { return fn(); } catch (cause) {
    const text = String(cause.message ?? cause);
    const colon = text.indexOf(':');
    const code = colon === -1 ? '' : text.slice(0, colon);
    const message = colon === -1 ? text : text.slice(colon + 2);
    const map = { MessageTooLongError, SyslogError, UnsupportedPlatformError, DecodeError: LogError };
    const Ctor = map[code] ?? LogError;
    throw new Ctor(message, { cause });
  }
}

function writeAll(sink, bytes) {
  let off = 0;
  while (off < bytes.length) {
    const n = sink.write(bytes.subarray(off));
    if (!Number.isInteger(n) || n < 0) throw new LogError('log: sink.write must return a non-negative integer');
    if (n === 0) throw new LogError('log: sink.write returned 0');
    off += n;
  }
}

function sinkFd(fd) {
  if (fd !== 1 && fd !== 2) throw new TypeError('log: fd must be 1 or 2');
  const stream = fd === 1 ? process.stdout : process.stderr;
  return { write(b) { stream.write(b); return b.length; } };
}

function sinkFile(path, opts) {
  if (typeof path !== 'string') throw new TypeError('log: path must be a string');
  const append = opts?.append !== false;
  const fd = openSync(path, append ? 'a' : 'w');
  return {
    write(b) { return writeSync(fd, b); },
    close() { closeSync(fd); },
  };
}

function goFmt(v) {
  if (v === undefined) return '<nil>';
  if (v === null) return '<nil>';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return v.message;
  return goValueFormat(v);
}

function goSprint(args, println) {
  if (println) return args.map(goFmt).join(' ') + '\n';
  let out = '';
  let prevString = false;
  for (let i = 0; i < args.length; i++) {
    const isStr = typeof args[i] === 'string';
    if (i > 0 && !prevString && !isStr) out += ' ';
    out += goFmt(args[i]);
    prevString = isStr;
  }
  return out;
}

function goSprintf(format, args) {
  let i = 0;
  return String(format).replace(/%(?:%|s|d|v|q|x)/g, (m) => {
    if (m === '%%') return '%';
    const a = args[i++];
    if (m === '%s' || m === '%v') return goFmt(a);
    if (m === '%d') return String(Number(a));
    if (m === '%q') return JSON.stringify(String(a));
    if (m === '%x') return Buffer.from(String(a)).toString('hex');
    return m;
  });
}

function capture(skip) {
  const prev = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => stack;
  const err = new Error();
  Error.captureStackTrace(err, capture);
  const stack = err.stack;
  Error.prepareStackTrace = prev;
  const frame = Array.isArray(stack) ? stack[skip] : undefined;
  if (!frame) return null;
  return {
    file: frame.getFileName() || '',
    line: frame.getLineNumber() || 0,
    function: frame.getFunctionName() || '',
  };
}

class Logger {
  constructor(out, prefix, flag) {
    this._out = out ?? sinkFd(2);
    this._prefix = prefix ?? '';
    this._flag = flag ?? L.StdFlags;
  }
  output(calldepth, msg) {
    let file = '';
    let line = 0;
    if (this._flag & (L.LongFile | L.ShortFile)) {
      const src = capture(calldepth);
      if (src) { file = src.file; line = src.line; }
      else { file = '???'; line = 0; }
    }
    const offset = new Date(Number(nowNs() / 1_000_000n)).getTimezoneOffset() * -60;
    const bytes = native(() => binding.formatLogLine(
      ...splitNs(nowNs()), offset, this._flag >>> 0, this._prefix, file, line, String(msg),
    ));
    writeAll(this._out, bytes);
  }
  print(...args) { this.output(1, goSprint(args, false)); }
  println(...args) { this.output(1, goSprint(args, true)); }
  printf(format, ...args) { this.output(1, goSprintf(format, args)); }
  fatal(...args) { this.print(...args); throw new FatalError(goSprint(args, false)); }
  fatalf(format, ...args) { this.printf(format, ...args); throw new FatalError(goSprintf(format, args)); }
  panic(...args) { this.print(...args); throw new PanicError(goSprint(args, false)); }
  setOutput(w) { this._out = w; }
  setFlags(flag) { this._flag = flag | 0; }
  flags() { return this._flag; }
  setPrefix(prefix) { this._prefix = String(prefix); }
  prefix() { return this._prefix; }
  writer() { return this._out; }
}

function newLogger(out, prefix, flag) { return new Logger(out, prefix, flag); }
const stdLogger = new Logger(sinkFd(2), '', L.StdFlags);
function print(...args) { stdLogger.print(...args); }
function println(...args) { stdLogger.println(...args); }
function printf(format, ...args) { stdLogger.printf(format, ...args); }
function fatal(...args) { stdLogger.fatal(...args); }
function panic(...args) { stdLogger.panic(...args); }
function output(calldepth, msg) { stdLogger.output(calldepth + 1, msg); }
function setOutput(w) { stdLogger.setOutput(w); }
function setFlags(flag) { stdLogger.setFlags(flag); }
function setPrefix(prefix) { stdLogger.setPrefix(prefix); }
function writer() { return stdLogger.writer(); }

class Value {
  constructor(kind, payload) {
    this.kind = kind;
    this._p = payload;
  }
}

class Attr {
  constructor(key, value) {
    this.key = key;
    this.value = value;
  }
}

function any(key, value) { return new Attr(String(key), anyValue(value)); }
function bool(key, v) { return new Attr(String(key), new Value(KIND.Bool, Boolean(v))); }
function duration(key, v) { return new Attr(String(key), new Value(KIND.Duration, BigInt(v))); }
function float64(key, v) { return new Attr(String(key), new Value(KIND.Float64, Number(v))); }
function int(key, v) { return new Attr(String(key), new Value(KIND.Int64, BigInt(Math.trunc(Number(v))))); }
function int64(key, v) { return new Attr(String(key), new Value(KIND.Int64, BigInt(v))); }
function string(key, v) { return new Attr(String(key), new Value(KIND.String, String(v))); }
function time(key, v) {
  const d = v instanceof Date ? v : new Date(v);
  return new Attr(String(key), new Value(KIND.Time, BigInt(d.getTime()) * 1_000_000n));
}
function uint64(key, v) { return new Attr(String(key), new Value(KIND.Uint64, BigInt(v))); }
function group(key, ...args) { return new Attr(String(key), new Value(KIND.Group, restAttrs(args))); }
function groupAttrs(key, attrs) { return new Attr(String(key), new Value(KIND.Group, [...attrs])); }

function anyValue(value) {
  const resolved = resolveValue(value);
  if (resolved instanceof Value) return resolved;
  if (resolved === null || resolved === undefined) {
    return new Value(KIND.Any, { text: '<nil>', json: 'null' });
  }
  if (typeof resolved === 'boolean') return new Value(KIND.Bool, resolved);
  if (typeof resolved === 'string') return new Value(KIND.String, resolved);
  if (typeof resolved === 'bigint') {
    return resolved < 0n ? new Value(KIND.Int64, resolved) : new Value(KIND.Uint64, resolved);
  }
  if (typeof resolved === 'number') {
    return Number.isInteger(resolved)
      ? new Value(KIND.Int64, BigInt(resolved))
      : new Value(KIND.Float64, resolved);
  }
  if (resolved instanceof Date) return new Value(KIND.Time, BigInt(resolved.getTime()) * 1_000_000n);
  return new Value(KIND.Any, { text: goValueFormat(resolved), json: jsonAny(resolved) });
}

function resolveValue(value, depth = 0) {
  if (value instanceof Value) {
    if (value.kind === KIND.LogValuer) return resolveValue(value._p, depth);
    return value;
  }
  if (value && typeof value.logValue === 'function') {
    if (depth >= 100) return new Value(KIND.Any, { text: 'LogValue called too many times', json: '"LogValue called too many times"' });
    return resolveValue(value.logValue(), depth + 1);
  }
  return value;
}

function goValueFormat(v) {
  if (v === null || v === undefined) return '<nil>';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return '[' + v.map(goValueFormat).join(' ') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return 'map[' + keys.map((k) => `${k}:${goValueFormat(v[k])}`).join(' ') + ']';
  }
  return String(v);
}

function jsonAny(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jsonAny).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + jsonAny(v[k])).join(',') + '}';
  }
  return 'null';
}

function restAttrs(args) {
  if (args.length % 2 !== 0) throw new BadKeyError('log/slog: odd-length attribute list');
  const attrs = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (typeof key !== 'string') throw new BadKeyError('log/slog: attribute key must be a string');
    const val = args[i + 1];
    attrs.push(val instanceof Attr ? new Attr(key, val.value) : any(key, val));
  }
  return attrs;
}

function pushU32(buf, n) {
  buf.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
}
function pushU64(buf, n) {
  let u = BigInt(n) & ((1n << 64n) - 1n);
  for (let i = 0; i < 8; i++) {
    buf.push(Number(u & 0xffn));
    u >>= 8n;
  }
}
function pushI64(buf, n) {
  let v = BigInt(n);
  if (v < 0n) v = (1n << 64n) + v;
  pushU64(buf, v);
}
function pushBytes(buf, bytes) {
  pushU32(buf, bytes.length);
  for (let i = 0; i < bytes.length; i++) buf.push(bytes[i]);
}
function pushStr(buf, s) { pushBytes(buf, Buffer.from(s)); }

function encodeAttrs(attrs) {
  const buf = [];
  pushU32(buf, attrs.length);
  for (const a of attrs) encodeAttr(buf, a);
  return Buffer.from(buf);
}

function encodeAttr(buf, a) {
  const v = resolveValue(a.value);
  pushStr(buf, a.key);
  const kind = v instanceof Value ? v.kind : KIND.Any;
  const p = v instanceof Value ? v._p : v;
  switch (kind) {
    case KIND.Bool:
      buf.push(KIND.Bool, p ? 1 : 0);
      break;
    case KIND.Duration:
      buf.push(KIND.Duration);
      pushI64(buf, p);
      break;
    case KIND.Float64: {
      buf.push(KIND.Float64);
      const tmp = Buffer.allocUnsafe(8);
      tmp.writeDoubleLE(Number(p));
      pushU64(buf, tmp.readBigUInt64LE());
      break;
    }
    case KIND.Int64:
      buf.push(KIND.Int64);
      pushI64(buf, p);
      break;
    case KIND.String:
      buf.push(KIND.String);
      pushStr(buf, String(p));
      break;
    case KIND.Time:
      buf.push(KIND.Time);
      pushI64(buf, p);
      break;
    case KIND.Uint64:
      buf.push(KIND.Uint64);
      pushU64(buf, p);
      break;
    case KIND.Group:
      buf.push(KIND.Group);
      const inner = encodeAttrs(p);
      for (let i = 0; i < inner.length; i++) buf.push(inner[i]);
      break;
    default: {
      const text = p && typeof p === 'object' && 'text' in p ? p.text : goValueFormat(p);
      const json = p && typeof p === 'object' && 'json' in p ? p.json : jsonAny(p);
      buf.push(KIND.Any);
      pushStr(buf, text);
      pushStr(buf, json);
    }
  }
}

function asLeveler(level) {
  if (level == null) return { level: () => LEVEL.Info };
  if (typeof level === 'number') return { level: () => level };
  if (typeof level.level === 'function') return level;
  throw new TypeError('log/slog: level must be a number or Leveler');
}

class LevelVar {
  constructor(l) { this._l = l ?? LEVEL.Info; }
  level() { return this._l; }
  set(l) { this._l = l; }
  toString() { return `LevelVar(${this._l})`; }
}

class Record {
  constructor(time, level, message, pc) {
    this.time = time ?? nowDate();
    this.level = level ?? LEVEL.Info;
    this.message = message ?? '';
    this.pc = pc == null ? 0n : BigInt(pc);
    this._attrs = [];
  }
  numAttrs() { return this._attrs.length; }
  attrs() { return this._attrs.slice(); }
  add(...args) { this._attrs.push(...restAttrs(args)); }
  addAttrs(...attrs) { this._attrs.push(...attrs); }
  clone() {
    const r = new Record(this.time, this.level, this.message, this.pc);
    r._attrs = this._attrs.slice();
    return r;
  }
}

function applyReplace(attrs, replace, groups) {
  if (!replace) return attrs;
  const out = [];
  for (const a of attrs) {
    const v = resolveValue(a.value);
    if (v instanceof Value && v.kind === KIND.Group) {
      const children = applyReplace(v._p, replace, a.key ? groups.concat(a.key) : groups);
      if (children.length) out.push(new Attr(a.key, new Value(KIND.Group, children)));
      continue;
    }
    const next = replace(groups, new Attr(a.key, v instanceof Value ? v : anyValue(v)));
    if (next == null) continue;
    out.push(next);
  }
  return out;
}

class NativeHandler {
  constructor(json, sink, opts) {
    this._json = json;
    this._sink = sink;
    this._opts = opts ?? {};
    this._level = asLeveler(this._opts.level);
    this._groups = [];
    this._with = [];
  }
  enabled(_ctx, level) { return level >= this._level.level(); }
  handle(_ctx, r) {
    if (!this.enabled(_ctx, r.level)) return;
    const replace = this._opts.replaceAttr;
    let withAttrs = applyReplace(this._with, replace, []);
    let recAttrs = applyReplace(r.attrs(), replace, this._groups);
    const addSource = !!this._opts.addSource;
    let sourceFile = '';
    let sourceLine = 0;
    let sourceFn = '';
    if (addSource) {
      if (r._source) {
        sourceFile = r._source.file || '';
        sourceLine = r._source.line || 0;
        sourceFn = r._source.function || '';
      } else {
        const src = capture(2);
        if (src) { sourceFile = src.file; sourceLine = src.line; sourceFn = src.function; }
      }
    }
    const hasTime = r.time instanceof Date && !Number.isNaN(r.time.getTime());
    const timeNs = hasTime ? BigInt(r.time.getTime()) * 1_000_000n + (nowNs() % 1_000_000n) : 0n;
    // Prefer the injected clock when the record time matches the test clock's millisecond.
    const clock = nowNs();
    const timeArg = hasTime && clockNs != null ? clock : timeNs;
    const bytes = native(() => binding.formatSlog(
      this._json, hasTime, ...splitNs(timeArg), r.level | 0, r.message,
      addSource, sourceFile, sourceLine, sourceFn,
      this._groups, encodeAttrs(withAttrs), encodeAttrs(recAttrs),
    ));
    writeAll(this._sink, bytes);
  }
  withAttrs(attrs) {
    const next = this._clone();
    next._with = next._with.concat(attrs);
    return next;
  }
  withGroup(name) {
    const next = this._clone();
    next._groups = next._groups.concat(String(name));
    return next;
  }
  _clone() {
    const n = new NativeHandler(this._json, this._sink, this._opts);
    n._groups = this._groups.slice();
    n._with = this._with.slice();
    n._level = this._level;
    return n;
  }
}

function newTextHandler(w, opts) { return new NativeHandler(false, w, opts); }
function newJsonHandler(w, opts) { return new NativeHandler(true, w, opts); }

class SlogLogger {
  constructor(handler) { this._h = handler; }
  handler() { return this._h; }
  enabled(ctx, level) { return this._h.enabled(ctx, level); }
  log(ctx, level, msg, ...args) {
    if (!this._h.enabled(ctx, level)) return;
    const r = new Record(nowDate(), level, msg, 0n);
    if (args.length) r.addAttrs(...restAttrs(args));
    this._h.handle(ctx, r);
  }
  logAttrs(ctx, level, msg, attrs) {
    if (!this._h.enabled(ctx, level)) return;
    const r = new Record(nowDate(), level, msg, 0n);
    if (attrs?.length) r.addAttrs(...attrs);
    this._h.handle(ctx, r);
  }
  debug(msg, ...args) { this.log(null, LEVEL.Debug, msg, ...args); }
  info(msg, ...args) { this.log(null, LEVEL.Info, msg, ...args); }
  warn(msg, ...args) { this.log(null, LEVEL.Warn, msg, ...args); }
  error(msg, ...args) { this.log(null, LEVEL.Error, msg, ...args); }
  with(...args) { return new SlogLogger(this._h.withAttrs(restAttrs(args))); }
  withGroup(name) {
    if (name === '') return this;
    return new SlogLogger(this._h.withGroup(name));
  }
}

function newLoggerDefault(h) { return new SlogLogger(h); }
let slogDefault = new SlogLogger(newTextHandler(sinkFd(2), { level: LEVEL.Info }));
function defaultLogger() { return slogDefault; }
function setDefault(l) { slogDefault = l; }
function slogDebug(msg, ...args) { slogDefault.debug(msg, ...args); }
function slogInfo(msg, ...args) { slogDefault.info(msg, ...args); }
function slogWarn(msg, ...args) { slogDefault.warn(msg, ...args); }
function slogError(msg, ...args) { slogDefault.error(msg, ...args); }
function slogLog(ctx, level, msg, ...args) { slogDefault.log(ctx, level, msg, ...args); }
function slogLogAttrs(ctx, level, msg, attrs) { slogDefault.logAttrs(ctx, level, msg, attrs); }

function newLogLogger(h, level) {
  return new Logger({
    write(b) {
      const msg = Buffer.from(b).toString('utf8').replace(/\n$/, '');
      const slog = new SlogLogger(h);
      slog.log(null, level, msg);
      return b.length;
    },
  }, '', 0);
}

class SyslogWriter {
  constructor(opts) {
    this._opts = opts;
    this._conn = opts.conn;
  }
  _send(severity, msg) {
    const pri = (this._opts.priority & 0xf8) | (severity & 0x07);
    const bytes = native(() => binding.formatSyslog(
      !!this._opts.local, pri, ...splitNs(nowNs()), this._opts.hostname || '', this._opts.tag, this._opts.pid >>> 0, msg,
    ));
    if (this._opts.network === 'udp' && bytes.length > 1024) {
      throw new MessageTooLongError('log/syslog: UDP message exceeds 1KiB');
    }
    if (this._opts.network === 'udp') {
      native(() => binding.syslogSendUdp(this._opts.raddr, bytes));
      return bytes.length;
    }
    if (this._opts.unixPath) {
      native(() => binding.syslogSendUnix(this._opts.unixPath, bytes));
      return Buffer.byteLength(msg);
    }
    if (typeof this._conn.write === 'function') {
      this._conn.write(bytes);
      return Buffer.byteLength(msg);
    }
    throw new SyslogError('log/syslog: writer is closed');
  }
  emerg(m) { this._send(SEVERITY.EMERG, m); }
  alert(m) { this._send(SEVERITY.ALERT, m); }
  crit(m) { this._send(SEVERITY.CRIT, m); }
  err(m) { this._send(SEVERITY.ERR, m); }
  warning(m) { this._send(SEVERITY.WARNING, m); }
  notice(m) { this._send(SEVERITY.NOTICE, m); }
  info(m) { this._send(SEVERITY.INFO, m); }
  debug(m) { this._send(SEVERITY.DEBUG, m); }
  write(b) {
    const msg = Buffer.from(b).toString('utf8');
    this._send(this._opts.priority & 0x07, msg);
    return b.length;
  }
  close() {
    if (this._conn && typeof this._conn.close === 'function') this._conn.close();
    else if (this._conn && typeof this._conn.end === 'function') this._conn.end();
    this._conn = null;
  }
}

function unixLogPaths() { return ['/dev/log', '/var/run/syslog', '/var/run/log']; }

function syslogDial(network, raddr, priority, tag) {
  if (process.platform === 'win32') throw new UnsupportedPlatformError('log/syslog: not supported on Windows');
  if (priority < 0 || priority > (FACILITY.LOCAL7 | SEVERITY.DEBUG)) {
    throw new SyslogError('log/syslog: invalid priority');
  }
  const hostname = require('node:os').hostname();
  const pid = process.pid;
  const useTag = tag || require('node:path').basename(process.argv[1] || 'node');
  if (!network) {
    const err = new SyslogError('Unix syslog delivery error');
    throw err;
  }
  if (network === 'udp') {
    return new SyslogWriter({
      network, raddr, priority, tag: useTag, hostname, pid, local: false, conn: { write() {} },
    });
  }
  if (network === 'tcp') {
    const conn = net.connect({ port: Number(raddr.split(':').pop()), host: raddr.replace(/:\d+$/, '') });
    return new SyslogWriter({ network, raddr, priority, tag: useTag, hostname, pid, local: false, conn });
  }
  throw new SyslogError(`log/syslog: unsupported network ${network}`);
}

function syslogNew(priority, tag) {
  if (process.platform === 'win32') throw new UnsupportedPlatformError('log/syslog: not supported on Windows');
  if (priority < 0 || priority > (FACILITY.LOCAL7 | SEVERITY.DEBUG)) {
    throw new SyslogError('log/syslog: invalid priority');
  }
  const hostname = require('node:os').hostname();
  const pid = process.pid;
  const useTag = tag || require('node:path').basename(process.argv[1] || 'node');
  for (const path of unixLogPaths()) {
    try {
      native(() => binding.syslogUnixConnect(path));
      return new SyslogWriter({
        network: 'unix', raddr: path, unixPath: path, local: true,
        priority, tag: useTag, hostname, pid, conn: { write() {} },
      });
    } catch {
      // try the next well-known path
    }
  }
  throw new SyslogError('Unix syslog delivery error');
}

function dtoKind(kind) {
  const map = { any: KIND.Any, Any: KIND.Any, Bool: KIND.Bool, Duration: KIND.Duration, Float64: KIND.Float64, Int64: KIND.Int64, String: KIND.String, Time: KIND.Time, Uint64: KIND.Uint64, Group: KIND.Group };
  return map[kind] ?? KIND.Any;
}

function attrFromDto(d) {
  switch (dtoKind(d.kind)) {
    case KIND.Bool: return bool(d.key, !!d.bool);
    case KIND.Duration: return duration(d.key, BigInt(d.durationNs || '0'));
    case KIND.Float64: return float64(d.key, d.float64 ?? 0);
    case KIND.Int64: return int64(d.key, d.int64 ?? 0);
    case KIND.String: return string(d.key, d.string ?? '');
    case KIND.Time: return new Attr(d.key, new Value(KIND.Time, BigInt(d.timeNs || '0')));
    case KIND.Uint64: return uint64(d.key, BigInt(d.uint64 || '0'));
    case KIND.Group: return new Attr(d.key, new Value(KIND.Group, (d.group || []).map(attrFromDto)));
    default: return new Attr(d.key, new Value(KIND.Any, { text: d.anyText ?? '<nil>', json: d.anyJson ?? 'null' }));
  }
}

function formatSlogCase(c, json) {
  const withAttrs = (c.withAttrs || []).map(attrFromDto);
  const attrs = (c.attrs || []).map(attrFromDto);
  return native(() => binding.formatSlog(
    json, true, ...splitNs(nowNs()), c.level | 0, c.msg,
    !!c.addSource, c.sourceFile || '', c.sourceLine | 0, c.sourceFn || '',
    c.groups || [], encodeAttrs(withAttrs), encodeAttrs(attrs),
  ));
}

function formatLogCase(c) {
  return native(() => binding.formatLogLine(
    ...splitNs(nowNs()), 0, c.flags >>> 0, c.prefix || '', c.file || '', c.line | 0, c.message || '',
  ));
}

function formatSyslogCase(c) {
  return native(() => binding.formatSyslog(
    !!c.local, c.priority >>> 0, ...splitNs(nowNs()), c.hostname || '', c.tag, c.pid >>> 0, c.msg,
  ));
}

module.exports = {
  L, LEVEL, KIND, TIME_KEY, LEVEL_KEY, MESSAGE_KEY, SOURCE_KEY, FACILITY, SEVERITY,
  LogError, BadKeyError, FatalError, PanicError, MessageTooLongError, UnsupportedPlatformError, SyslogError,
  Logger, newLogger, print, println, printf, fatal, panic, output, setOutput, setFlags, setPrefix, writer, sinkFd, sinkFile,
  Value, Attr, any, bool, duration, float64, int, int64, string, time, uint64, group, groupAttrs,
  Record, LevelVar, SlogLogger, newTextHandler, newJsonHandler, newLoggerDefault, newLogLogger,
  defaultLogger, setDefault,
  debug: slogDebug, info: slogInfo, warn: slogWarn, error: slogError, log: slogLog, logAttrs: slogLogAttrs,
  SyslogWriter, syslogNew, syslogDial,
  setClock, formatSlogCase, formatLogCase, formatSyslogCase, attrFromDto,
};
