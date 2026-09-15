# rustd-serial

Synchronous Rust + Node-API port of Go `encoding/csv`, `encoding/pem`,
`encoding/asn1` (DER only), and `encoding/xml`.

Runtime Node >=20; no JavaScript runtime dependencies.

```js
import {
  CsvReader, CsvWriter, pemDecode, pemEncode, asn1Marshal, asn1Unmarshal,
  XmlDecoder, xmlMarshal, xmlUnmarshal, xmlEscape, XML_HEADER,
} from 'rustd-serial';

const rows = new CsvReader(Buffer.from('a,b\n1,2\n'), { fieldsPerRecord: -1 }).readAll();
const w = new CsvWriter();
w.writeAll(rows);
const csvBytes = w.bytes();

const encoded = pemEncode({ type: 'FOO', bytes: Buffer.from('hello') });
const found = pemDecode(encoded); // null if no PEM block

const schema = {
  kind: 'sequence',
  fields: [
    { name: 'n', schema: { kind: 'int' } },
    { name: 'oid', schema: { kind: 'oid' } },
  ],
};
const der = asn1Marshal({ n: 1, oid: [1, 2, 840, 113549] }, schema);
const { value, rest } = asn1Unmarshal(der, schema);

const person = {
  name: 'person',
  kind: 'element',
  children: [
    { name: 'id', kind: 'attr', type: 'int' },
    { name: 'name', kind: 'element', type: 'string' },
  ],
};
const xml = xmlMarshal({ id: 1, name: 'Ann' }, person);
const again = xmlUnmarshal(xml, person);
const tokens = [];
const dec = new XmlDecoder('<a>x</a>');
for (;;) { const t = dec.token(); if (!t) break; tokens.push(t); }
```

`CsvReader` takes a complete `Uint8Array`. Incremental stream parsing is out of
scope until `rustd-io` lands. There is no `close()`: the native objects do not
hold file descriptors.

## Differences from Go

- `ReuseRecord` is not ported. Every `read()` / `readBytes()` returns a new
  array. Sharing backing storage would alias JS typed arrays across calls.
- `TrailingComma` remains unused, matching Go's deprecation.
- `read()` returns `string[]` and throws `CsvEncodingError` when a field is not
  valid UTF-8. Go strings may contain arbitrary bytes. Use `readBytes()` for
  the original field bytes (including the Go `BinaryBlobField` case).
- Errors are thrown, not `(record, error)`. `ErrFieldCount` still fills
  `startLine` / `line` / `column` like `ParseError`, but the partial record is
  not returned.
- Invalid comma/comment delimiters throw `TypeError` at construction (Go waits
  until the first `Read`/`Write`).
- `fieldPos` throws `RangeError` instead of panicking.
- `pemDecode` returns `null` when no PEM block is found (Go returns `(nil, data)`).
  The original input is not wrapped as `{ rest }`; call sites that need the
  unparsed bytes already have them.
- `pemEncode` throws `PemEncodeError` on a header key that contains `:`, matching
  Go `Encode`. Go `EncodeToMemory` returns `nil` for that case and is not
  exported here.
- PEM header maps do not preserve insertion order. Encode writes `Proc-Type`
  first, then remaining keys sorted, matching Go.
- ASN.1 mapping uses an explicit `Asn1Schema`. There is no reflect/`struct` tag
  inference. `params` (Go `MarshalWithParams` / field tag string) overrides
  schema tagging, string type, time type, `set`, and `optional`.
- Optional fields omit only `null` / missing values. Go also omits typed zero
  values (`0`, `false`, empty slice) for `optional` without `omitempty`.
- `kind: 'int'` unmarshals to `number` when `|n| <= Number.MAX_SAFE_INTEGER`,
  otherwise `bigint`. `kind: 'bigint'` always returns `bigint`.
- Times are `Date` values in UTC. Offsets other than `Z` are converted to UTC
  milliseconds.
- DER-only: indefinite length, non-minimal length, and non-minimal integers
  are errors (`Asn1SyntaxError` vs `Asn1StructuralError` match Go's split).
- Nested values deeper than 256 tags fail with `Asn1SyntaxError` instead of
  overflowing the stack. OID arcs are `number[]`; legality follows Go
  (`first > 2` or `first < 2 && second >= 40` is a structural error).
- The `der` crate is not used. TLV is a Go-faithful port so SyntaxError /
  StructuralError and arbitrary OID arcs stay aligned.
- XML mapping uses an explicit `XmlSchema` (`kind` discriminant) instead of
  Go struct tags. `tag` / `path` still accept Go-style `name,attr` and
  `a>b>c` strings. `,cdata` is a `kind: 'chardata'` field with `tag: ',cdata'`
  (no extra schema kind): marshal wraps text in `<![CDATA[...]]>` and splits
  on `]]>` the same way as Go `emitCDATA`. Repeated child elements become arrays.
- `CharsetReader` runs in JavaScript (`TextDecoder` by default) and feeds
  UTF-8 into the native parser. The native tokenizer does not switch readers
  mid-stream.
- `HTML_ENTITY` / `HTML_AUTO_CLOSE` are frozen copies; `getHtmlEntity()` /
  `getHtmlAutoClose()` return mutable copies. Custom `Entity` replacements
  are inserted as text and not re-expanded (same as Go), so `&x;` defined
  as `&x;` does not loop.
- Nesting deeper than 10_000 start tags is a `XmlSyntaxError` instead of a
  stack overflow. Go has no such cap.
- `quick-xml` is not used. The tokenizer is a Go-faithful port so
  `Strict=false`, `AutoClose`, line numbers, and entity tables stay aligned.
- `path: 'a>b>c'` (and `tag: 'a>b>c'`) walks nested wrappers on both marshal
  and unmarshal. Repeated matching leaves become arrays, same as other child
  elements. A single matching leaf stays a scalar, unlike Go's `[]T` which is
  always a slice.

## Size

Local Linux x64 GNU release + strip, Rust 1.97.1 (2026-09-14): **701,056 bytes** (issue cap 2 MB).

```text
$ ls -l packages/rustd-serial/*.node
-rwxrwxr-x 1 akrc akrc 701056 Sep 14 18:00 packages/rustd-serial/rustd-serial.linux-x64-gnu.node
```
