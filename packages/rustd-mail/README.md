# rustd-mail

Synchronous Rust + Node-API port of Go `net/mail` (message, address, and
RFC 5322 date parsing). SMTP (`net/smtp`) is not in this slice; it waits on
`rustd-net` / `rustd-tls`.

Runtime Node >=20; no JavaScript runtime dependencies.

```js
import { readMessage, parseAddress, parseAddressList, parseDate } from 'rustd-mail';

const msg = readMessage(Buffer.from('From: A <a@b.com>\n\nHello\n'));
msg.header.get('From');          // 'A <a@b.com>'
msg.header.addressList('From');  // [MailAddress { name: 'A', address: 'a@b.com' }]
msg.body;                        // raw body bytes; no MIME recursion
parseAddress('John Doe <jdoe@machine.example>');
parseDate('Fri, 21 Nov 1997 09:55:06 -0600');
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
  us-ascii, and iso-8859-1 throw. Custom `mime.WordDecoder` / `CharsetReader`
  is not exposed; the Go default decoder is used (utf-8 / us-ascii / iso-8859-1).
- Named zones without a numeric offset (CST, PDT, …) use offset 0 when the
  abbreviation is not GMT/UT/UTC, matching Go `time.Parse` on a location that
  does not define that abbreviation. Prefer numeric offsets for portable instants.
- RFC 5322 dates are parsed in this package; they are not HTTP dates.
- SMTP, STARTTLS, and `SmtpClient` are out of scope for 0.1.0 mail-parse.

## Size

Local Linux x64 GNU release probe, Rust 1.97.1 (2026-09-14): **414,800 bytes**.

```text
$ ls -l packages/rustd-mail/*.node
-rwxrwxr-x 1 akrc akrc 414800 Sep 14 18:43 packages/rustd-mail/rustd-mail.linux-x64-gnu.node
```
