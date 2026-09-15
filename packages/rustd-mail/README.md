# rustd-mail

Rust + Node-API port of Go `net/mail` (RFC 5322 message/address/date parse)
and `net/smtp` (`SmtpClient`, `sendMail`, `plainAuth` / `loginAuth` / `cramMd5Auth`).

Runtime Node >=20; no JavaScript runtime dependencies. rustd-net was cancelled,
so SMTP uses an in-crate TCP client (`std::net::TcpStream`). STARTTLS upgrades
that socket with Node `tls` (rustd-tls is out of plan). `SmtpError` is local
(there is no shared `TextProtoError`).

```js
import { readMessage, parseAddress, sendMail, plainAuth, SmtpClient } from 'rustd-mail';

readMessage(Buffer.from('From: A <a@b.com>\n\nHello\n'));
parseAddress('John Doe <jdoe@machine.example>');

await sendMail('127.0.0.1:2525', plainAuth({
  username: 'user', password: 'pass', host: '127.0.0.1',
}), 'a@b.com', ['c@d.com'], 'From: a@b.com\r\nTo: c@d.com\r\n\r\nHi\r\n');
```

## Differences from Go

- `MailError` is a JavaScript-only type (`kind`: `header` | `address` | `date` |
  `syntax`) with `code: 'MAIL'`. Go `net/mail` has `ErrHeaderNotPresent` and
  untyped errors. Messages keep Go's wording, including the `mail:` prefix
  where Go uses it.
- `MailHeader.set` / `setDate` are JS helpers. Go's `Header` is a map;
  `setDate` always emits UTC `Mon, 02 Jan 2006 15:04:05 +0000`.
- `MailHeader.keys()` preserves first-seen canonical key order. Go iterates a
  map.
- Header names are canonicalized with Go `CanonicalMIMEHeaderKey` (`Message-Id`,
  not the original spelling).
- `readMessage` takes in-memory `Uint8Array` or string, not `io.Reader`.
- `bodyText()` / `mediaType()` are JS conveniences. Missing `Content-Type`
  defaults to `text/plain; charset=us-ascii`. Charsets other than utf-8,
  us-ascii, and iso-8859-1 throw.
- RFC 5322 dates are parsed in this package; they are not HTTP dates.
- There is no `NetConn` / `SmtpClient.fromConn`. `SmtpClient.dial(address, {
  host })` maps to Go `Dial` + `NewClient`'s host name (auth / TLS identity).
  Default `host` is the host in `address`.
- `SmtpError` matches `textproto.Error` (`code` / `serverMessage`, message
  `NNN ...`) and adds `command` plus `permanent` (`code >= 500`).
- `extension` / `extensionParams` are synchronous and do not send EHLO.
  Call `hello()`, `mail()`, or `sendMail` first. Go's `Extension` may I/O.
- `startTls(config?)` sends `STARTTLS`, expects 220, then upgrades with Node
  `tls` (not `rustd-tls`, which is out of plan). It always re-sends `EHLO`
  after the handshake, matching Go. Default `rejectUnauthorized` is true.
  Pass `{ ca }` for a private CA. There is no plaintext continuation if the
  handshake fails. `sendMail` calls `startTls(opts.tls)` when the server
  advertises STARTTLS. Node omits SNI when the name is an IP (RFC 6066);
  certificate identity is still checked against that IP.
- `dial(addr, { tls: { implicit: true, ca, serverName } })` TLS-wraps the
  socket **before** the 220 banner. That is Go `tls.Dial` + `smtp.NewClient`
  (`client.tls == true` immediately). rustd-net `fromConn` is out of plan.
  `plainAuth` then allows a non-localhost host (for example `smtp.test.local`)
  because the session is already TLS. `sendMail` uses this when
  `opts.tls.implicit` is set and still will STARTTLS if the server later
  advertises it.
- `tlsConnectionState()` returns a small local object after a successful
  upgrade (`protocol`, `authorized`, `serverName`, `cipher`), not a
  `rustd-tls` type. It is `null` before STARTTLS.
- `FeatureNotBuiltError` remains exported for compatibility; the STARTTLS
  handshake is built.
- `loginAuth` is extra (Go stdlib has PLAIN and CRAM-MD5 only). Same
  TLS-or-localhost rule as `plainAuth`.
- DATA lines longer than 998 bytes throw (RFC 5321). Go's `DotWriter` does not
  enforce this.
- Default dial timeout is 30s (connect + read/write). Pass `{ timeoutMs: 0 }`
  for Go-like blocking. Expired waits throw `smtp: connection timed out`.
- `sendMail` on MAIL/RCPT/DATA failure closes the TCP socket without `QUIT`,
  matching Go `defer c.Close()`. `Auth` failure still sends `*` then `QUIT`.
- No connection pool; one `SmtpClient` is one TCP connection.
- Server response lines have no extra cap (Go `textproto.ReadLine` is
  unlimited). `250-` then a non-code line is kept as RFC 959 continuation,
  matching Go. DATA *client* lines over 998 bytes still throw.

## Size

Local Linux x64 GNU release probe is asserted in tests: **≤ 2 MB** stripped.
