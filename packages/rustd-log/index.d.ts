export const L: {
  readonly Date: 1; readonly Time: 2; readonly Microseconds: 4; readonly LongFile: 8;
  readonly ShortFile: 16; readonly UTC: 32; readonly MsgPrefix: 64; readonly StdFlags: number;
};
export interface LogSink { write(b: Uint8Array): number }
export function sinkFd(fd: 1 | 2): LogSink;
export function sinkFile(path: string, opts?: { append?: boolean }): LogSink;

export class LogError extends Error { readonly code: string }
export class BadKeyError extends LogError {}
export class FatalError extends LogError {}
export class PanicError extends LogError {}
export class MessageTooLongError extends LogError {}
export class UnsupportedPlatformError extends LogError {}
export class SyslogError extends LogError {}

/** Classic `log.Logger`. slog's logger is `SlogLogger` because one TS module cannot export two classes named Logger. */
export class Logger {
  constructor(out?: LogSink, prefix?: string, flag?: number);
  output(calldepth: number, msg: string): void;
  print(...args: unknown[]): void;
  printf(format: string, ...args: unknown[]): void;
  println(...args: unknown[]): void;
  fatal(...args: unknown[]): never;
  fatalf(format: string, ...args: unknown[]): never;
  panic(...args: unknown[]): never;
  setOutput(w: LogSink): void;
  setFlags(flag: number): void;
  flags(): number;
  setPrefix(prefix: string): void;
  prefix(): string;
  writer(): LogSink;
}
export function newLogger(out: LogSink, prefix: string, flag: number): Logger;
export function print(...args: unknown[]): void;
export function printf(format: string, ...args: unknown[]): void;
export function println(...args: unknown[]): void;
export function setOutput(w: LogSink): void;
export function setFlags(flag: number): void;
export function setPrefix(prefix: string): void;
export function fatal(...args: unknown[]): never;
export function panic(...args: unknown[]): never;
export function output(calldepth: number, msg: string): void;
export function writer(): LogSink;

export type Level = number;
export const LEVEL: { readonly Debug: -4; readonly Info: 0; readonly Warn: 4; readonly Error: 8 };
export const SOURCE_KEY: 'source';
export const TIME_KEY: 'time';
export const LEVEL_KEY: 'level';
export const MESSAGE_KEY: 'msg';
export interface Leveler { level(): Level }
export class LevelVar implements Leveler {
  constructor(l?: Level);
  level(): Level;
  set(l: Level): void;
  toString(): string;
}
export interface Handler {
  enabled(ctx: unknown | null, level: Level): boolean;
  handle(ctx: unknown | null, r: Record): void;
  withAttrs(attrs: Attr[]): Handler;
  withGroup(name: string): Handler;
}
export interface HandlerOptions {
  level?: Level | Leveler;
  addSource?: boolean;
  replaceAttr?: (groups: string[], a: Attr) => Attr | null;
}
/** Go `slog.Logger`. */
export class SlogLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  log(ctx: unknown | null, level: Level, msg: string, ...args: unknown[]): void;
  logAttrs(ctx: unknown | null, level: Level, msg: string, attrs: Attr[]): void;
  with(...args: unknown[]): SlogLogger;
  withGroup(name: string): SlogLogger;
  enabled(ctx: unknown | null, level: Level): boolean;
  handler(): Handler;
}
export function defaultLogger(): SlogLogger;
export function setDefault(l: SlogLogger): void;
export function newTextHandler(w: LogSink, opts?: HandlerOptions): Handler;
export function newJsonHandler(w: LogSink, opts?: HandlerOptions): Handler;
export function newLogLogger(h: Handler, level: Level): Logger;
export function newLoggerDefault(h: Handler): SlogLogger;
export function debug(msg: string, ...args: unknown[]): void;
export function info(msg: string, ...args: unknown[]): void;
export function warn(msg: string, ...args: unknown[]): void;
export function error(msg: string, ...args: unknown[]): void;
export function log(ctx: unknown | null, level: Level, msg: string, ...args: unknown[]): void;
export function logAttrs(ctx: unknown | null, level: Level, msg: string, attrs: Attr[]): void;

export class Attr { readonly key: string; readonly value: Value }
export class Value { readonly kind: ValueKind }
export const KIND: { readonly Any: 0; readonly Bool: 1; readonly Duration: 2; readonly Float64: 3; readonly Int64: 4; readonly String: 5; readonly Time: 6; readonly Uint64: 7; readonly Group: 8; readonly LogValuer: 9 };
export type ValueKind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export function any(key: string, value: unknown): Attr;
export function bool(key: string, v: boolean): Attr;
export function duration(key: string, v: bigint): Attr;
export function float64(key: string, v: number): Attr;
export function int(key: string, v: number): Attr;
export function int64(key: string, v: bigint): Attr;
export function string(key: string, v: string): Attr;
export function time(key: string, v: Date): Attr;
export function uint64(key: string, v: bigint): Attr;
export function group(key: string, ...args: unknown[]): Attr;
export function groupAttrs(key: string, attrs: Attr[]): Attr;
export class Record {
  constructor(time?: Date, level?: Level, message?: string, pc?: bigint);
  time: Date; message: string; level: Level; pc: bigint;
  numAttrs(): number;
  attrs(): Attr[];
  add(...args: unknown[]): void;
  addAttrs(...attrs: Attr[]): void;
  clone(): Record;
}
export interface LogValuer { logValue(): Value }
export interface Source { function: string; file: string; line: number }

export const FACILITY: { readonly [k: string]: number };
export const SEVERITY: { readonly [k: string]: number };
export function syslogNew(priority: number, tag: string): SyslogWriter;
export function syslogDial(network: 'udp' | 'tcp' | 'unix' | 'unixgram', raddr: string, priority: number, tag: string): SyslogWriter;
export class SyslogWriter {
  emerg(m: string): void; alert(m: string): void; crit(m: string): void; err(m: string): void;
  warning(m: string): void; notice(m: string): void; info(m: string): void; debug(m: string): void;
  write(b: Uint8Array): number;
  close(): void;
}

/** Test hook: inject a unix-nanosecond clock. Pass null to restore Date.now. */
export function setClock(ns: bigint | number | null): void;
