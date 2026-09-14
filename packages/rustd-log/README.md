# rustd-log

Go `log`, `log/slog`, and `log/syslog` for Node via a Rust N-API addon.
Formatting is implemented in native code against Go 1.24.13's actual output
(the local toolchain contract), not against a tracing crate.

## Install

```js
const { Logger, L, newTextHandler, newLoggerDefault, LEVEL } = require('rustd-log');
import { info, string, int } from 'rustd-log';
```

Classic logger:

```js
const log = new Logger(process.stderr, '', L.StdFlags | L.UTC);
log.printf('n=%d', 7);
```

Structured logger:

```js
const slog = newLoggerDefault(newTextHandler({ write(b) { process.stdout.write(b); return b.length; } }, { level: LEVEL.Info }));
slog.info('connected', 'host', 'db', 'n', 3);
```

## Output format matrix

| | TextHandler | JSONHandler |
| --- | --- | --- |
| field order | `time= level= [source=] msg= attrs…` | `{"time", "level", ["source"], "msg", attrs…}` then newline |
| time | RFC3339 milliseconds (`2009-11-10T23:00:00.123Z`) | RFC3339Nano (`2009-11-10T23:00:00.123456789Z`) |
| duration | `time.Duration.String` (`1.5s`) | nanoseconds integer |
| strings | `strconv.Quote` when space/`=`/controls | JSON string, **no** HTML escaping |
| groups | `g.k=v` | nested object |
| empty group name | inline attrs | inline attrs |
| uint64 | decimal, full range via `bigint` | decimal |

Classic `log` headers match `2006/01/02 15:04:05` / `.000000` / `LUTC`.

Syslog matches Go 1.24 `log/syslog`: local `<%d>%s %s[%d]: %s` with `time.Stamp`,
network `<%d>%s %s %s[%d]: %s` with RFC3339 and hostname. This is **not** the
RFC 3164 form without PID from the issue draft.

## Differences from Go

- Non-string rest keys throw `BadKeyError` instead of writing `!BADKEY`.
- `fatal` / `panic` throw `FatalError` / `PanicError` and never call `process.exit`.
- `AddSource` uses V8 `Error.prepareStackTrace`. Missing frames become empty, never forged.
- No log rotation, no async handlers, no Windows Event Log.
- slog `Logger` is exported as `SlogLogger` because a single TypeScript module cannot contain two `Logger` classes. Classic `log.Logger` keeps the name `Logger`.
- JSONHandler follows Go 1.24 `SetEscapeHTML(false)`: `<`, `>`, `&` are **not** `\u003c` / `\u003e` / `\u0026`. The issue draft claimed HTML escaping; stdlib slog disables it. Native output is byte-equal to `go1.24.13`.
- JSON record time is RFC3339Nano, not 3-digit millis (millis is the text handler).
- UDP messages larger than 1KiB throw `MessageTooLongError` instead of silent truncation.
- `Any` of a JS object uses `map[k:v]` in text and JSON objects in JSON, matching Go `fmt %+v` / `encoding/json` for maps.

This package is not the Rust `slog` crate.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **406,536 bytes**.

```text
$ ls -l packages/rustd-log/*.node
-rwxrwxr-x 1 akrc akrc 406536 Sep 14 16:40 packages/rustd-log/rustd-log.linux-x64-gnu.node
```
