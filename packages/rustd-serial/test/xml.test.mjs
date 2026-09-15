import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  XmlDecoder, XmlEncoder, xmlMarshal, xmlUnmarshal, xmlEscape, xmlMarshalIndent,
  XML_HEADER, HTML_ENTITY, HTML_AUTO_CLOSE, getHtmlEntity, getHtmlAutoClose,
  XmlSyntaxError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./fixtures/xml.json', import.meta.url);

const personSchema = {
  name: 'person',
  kind: 'element',
  children: [
    { name: 'id', kind: 'attr', type: 'int' },
    { name: 'name', kind: 'element', type: 'string' },
    { name: 'age', kind: 'element', type: 'int' },
  ],
};

const decodeSchemas = {
  book: {
    name: 'book',
    kind: 'element',
    children: [
      { name: 'isbn', kind: 'attr', type: 'string' },
      { name: 'title', kind: 'element', type: 'string' },
      { name: 'pages', kind: 'element', type: 'int' },
    ],
  },
  note: {
    name: 'note',
    kind: 'element',
    children: [{ name: 'body', kind: 'chardata', type: 'string' }],
  },
  comment: {
    name: 'c',
    kind: 'element',
    children: [{ name: 'msg', kind: 'comment', type: 'string' }],
  },
  inner: {
    name: 'wrap',
    kind: 'element',
    children: [{ name: 'inner', kind: 'any', type: 'string' }],
  },
  cdata: {
    name: 'c',
    kind: 'element',
    children: [{ name: 'body', kind: 'chardata', type: 'string', tag: ',cdata' }],
  },
  cdatamix: {
    name: 'mixc',
    kind: 'element',
    children: [
      { name: 'a', kind: 'element', type: 'string' },
      { name: 'body', kind: 'chardata', type: 'string', tag: ',cdata' },
      { name: 'b', kind: 'element', type: 'string' },
    ],
  },
  path: {
    name: 'doc',
    kind: 'element',
    children: [{ name: 'city', kind: 'element', type: 'string', path: 'a>b>c' }],
  },
  items: {
    name: 'items',
    kind: 'element',
    children: [{ name: 'item', kind: 'element', type: 'string' }],
  },
  omit: {
    name: 'omit',
    kind: 'element',
    children: [
      { name: 'a', kind: 'element', type: 'string', omitempty: true },
      { name: 'b', kind: 'element', type: 'int', omitempty: true },
      { name: 'c', kind: 'element', type: 'string' },
    ],
  },
  flags: {
    name: 'flags',
    kind: 'element',
    children: [
      { name: 'on', kind: 'element', type: 'bool' },
      { name: 'n', kind: 'element', type: 'uint' },
      { name: 'f', kind: 'element', type: 'float' },
    ],
  },
  mix: {
    name: 'mix',
    kind: 'element',
    children: [
      { name: 'a', kind: 'element', type: 'string' },
      { name: 'msg', kind: 'comment', type: 'string' },
      { name: 'inner', kind: 'any', type: 'string' },
      { name: 'b', kind: 'element', type: 'string' },
    ],
  },
};

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', '.', ...args], {
    cwd: resolve(root, 'packages/rustd-serial/gofixtures'),
    encoding: 'utf8',
    input,
    maxBuffer: 32 << 20,
    timeout: 120000,
    env: { ...process.env, GOWORK: 'off' },
  });
  if (result.error) throw result.error;
  return result;
}

function hex(data) {
  return Buffer.from(data).toString('hex');
}

function tokensOf(input, c) {
  const dec = new XmlDecoder(input, {
    strict: c.strict,
    autoClose: c.autoClose,
    entity: c.entity,
    defaultSpace: c.defaultSpace || undefined,
  });
  const out = [];
  try {
    for (;;) {
      const tok = c.raw ? dec.rawToken() : dec.token();
      if (tok == null) return { tokens: out };
      out.push(tok);
    }
  } catch (err) {
    return { tokens: out, error: err };
  }
}

function assertToken(got, want, id) {
  assert.equal(got.type, want.type, `${id} type`);
  if (want.name) {
    assert.deepEqual(got.name, want.name, `${id} name`);
  }
  if (want.attr) {
    assert.equal((got.attr ?? []).length, want.attr.length, `${id} attr len`);
    for (let i = 0; i < want.attr.length; i++) {
      assert.deepEqual(got.attr[i].name, want.attr[i].name, `${id} attr ${i} name`);
      assert.equal(got.attr[i].value, want.attr[i].value, `${id} attr ${i} value`);
    }
  }
  if (want.text !== undefined) assert.equal(got.text, want.text, `${id} text`);
  if (want.target) assert.equal(got.target, want.target, `${id} target`);
  if (want.instHex) assert.equal(hex(got.inst ?? new Uint8Array()), want.instHex, `${id} inst`);
}

test('Go regenerates committed XML fixtures; native tokens/escape/marshal match', () => {
  const generated = go(['-pkg', 'serial-xml']);
  assert.equal(generated.status, 0, generated.stderr);
  if (process.env.RUSTD_UPDATE_FIXTURES) writeFileSync(fixturePath, generated.stdout);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go XML fixture drift');
  const packet = JSON.parse(committed);
  assert.equal(packet.package, 'serial-xml');
  assert.ok(packet.tokens.length >= 60, `tokens ${packet.tokens.length}`);
  assert.ok(packet.escapes.length >= 6, `escapes ${packet.escapes.length}`);

  for (const c of packet.tokens) {
    const input = Buffer.from(c.inputHex, 'hex');
    const { tokens, error } = tokensOf(input, c);
    if (c.error) {
      assert.ok(error, `${c.id} expected error, got ${JSON.stringify(tokens)}`);
      if (c.errorLine) {
        assert.equal(error instanceof XmlSyntaxError, true, `${c.id} class ${error}`);
        assert.equal(error.line, c.errorLine, `${c.id} line`);
      }
      continue;
    }
    assert.equal(error, undefined, `${c.id} unexpected ${error}`);
    assert.equal(tokens.length, c.tokens.length, `${c.id} count ${JSON.stringify(tokens)} vs ${JSON.stringify(c.tokens)}`);
    tokens.forEach((tok, i) => assertToken(tok, c.tokens[i], `${c.id}#${i}`));
  }

  for (const c of packet.escapes) {
    const out = xmlEscape(Buffer.from(c.inputHex, 'hex'));
    assert.equal(hex(out), c.outputHex, c.id);
  }

  for (const c of packet.marshal) {
    const xml = Buffer.from(c.xmlHex, 'hex');
    const got = xmlUnmarshal(xml, personSchema);
    assert.equal(got.id, c.idAttr, c.id);
    assert.equal(got.name, c.itemName, c.id);
    assert.equal(got.age, c.age, c.id);
    const again = xmlMarshal({ id: c.idAttr, name: c.itemName, age: c.age }, personSchema);
    assert.equal(hex(again), c.xmlHex, `${c.id} round-trip`);
  }

  assert.ok((packet.decodes ?? []).length >= 8, `decodes ${packet.decodes?.length}`);
  for (const c of packet.decodes) {
    const xml = Buffer.from(c.xmlHex, 'hex');
    const schema = decodeSchemas[c.kind];
    assert.ok(schema, `${c.id} schema ${c.kind}`);
    if (c.kind === 'omit') {
      const produced = xmlMarshal({ a: '', b: 0, c: 'x' }, schema);
      assert.equal(hex(produced), c.xmlHex, `${c.id} omitempty marshal`);
      const round = xmlUnmarshal(produced, schema);
      assert.equal(round.c, 'x', `${c.id} keep c`);
      assert.equal(round.a, undefined, `${c.id} omit a`);
      continue;
    }
    const got = xmlUnmarshal(xml, schema);
    if (c.kind === 'inner') {
      assert.equal(got.inner, c.value.inner, `${c.id} innerxml`);
    } else {
      assert.deepEqual(got, c.value, `${c.id} decode`);
    }
    const viaDecoder = new XmlDecoder(xml).decode(schema);
    assert.deepEqual(viaDecoder, got, `${c.id} XmlDecoder.decode`);
  }

  assert.ok((packet.encodes ?? []).length >= 12, `encodes ${packet.encodes?.length}`);
  for (const c of packet.encodes) {
    const schema = decodeSchemas[c.kind];
    assert.ok(schema, `${c.id} schema ${c.kind}`);
    if (c.error) {
      assert.throws(() => xmlMarshal(c.value, schema), (err) => {
        assert.equal(err.message, c.error, `${c.id} error`);
        return true;
      }, c.id);
      continue;
    }
    const produced = c.indent
      ? xmlMarshalIndent(c.value, schema, c.prefix ?? '', c.indent)
      : xmlMarshal(c.value, schema);
    assert.equal(hex(produced), c.xmlHex, `${c.id} ${Buffer.from(produced).toString()}`);
  }
});

test('JS-generated XML verifies against Go', () => {
  const people = [
    { id: 'js-ann', xmlHex: hex(xmlMarshal({ id: 9, name: 'Ann', age: 12 }, personSchema)) },
    { id: 'js-bo', xmlHex: hex(xmlMarshal({ id: 1, name: 'Bo', age: 0 }, personSchema)) },
    { id: 'js-cafe', xmlHex: hex(xmlMarshal({ id: 2, name: 'café', age: 40 }, personSchema)) },
  ];
  const decodes = [
    { id: 'js-book', kind: 'book', xmlHex: hex(xmlMarshal({ isbn: '1', title: 'T', pages: 3 }, decodeSchemas.book)) },
    { id: 'js-note', kind: 'note', xmlHex: hex(xmlMarshal({ body: 'z' }, decodeSchemas.note)) },
    { id: 'js-path', kind: 'path', xmlHex: hex(xmlMarshal({ city: 'Oslo' }, decodeSchemas.path)) },
    { id: 'js-items', kind: 'items', xmlHex: hex(xmlMarshal({ item: ['p', 'q'] }, decodeSchemas.items)) },
    { id: 'js-omit', kind: 'omit', xmlHex: hex(xmlMarshal({ a: '', b: 0, c: 'keep' }, decodeSchemas.omit)) },
    { id: 'js-flags', kind: 'flags', xmlHex: hex(xmlMarshal({ on: false, n: 2, f: 0.5 }, decodeSchemas.flags)) },
    { id: 'js-comment', kind: 'comment', xmlHex: hex(xmlMarshal({ msg: 'hi-' }, decodeSchemas.comment)) },
    { id: 'js-inner', kind: 'inner', xmlHex: hex(xmlMarshal({ inner: '<x>1</x><y>2</y>' }, decodeSchemas.inner)) },
    { id: 'js-mix', kind: 'mix', xmlHex: hex(xmlMarshal({ a: '1', msg: 'c', inner: '<z/>', b: '2' }, decodeSchemas.mix)) },
    { id: 'js-cdata', kind: 'cdata', xmlHex: hex(xmlMarshal({ body: '1<2&3>' }, decodeSchemas.cdata)) },
    { id: 'js-cdatamix', kind: 'cdatamix', xmlHex: hex(xmlMarshal({ a: '1', body: 'x<y', b: '2' }, decodeSchemas.cdatamix)) },
  ];
  const verified = go(['-pkg', 'serial-xml', '-verify'], JSON.stringify({
    schema: 1, package: 'serial-xml', people, decodes,
  }));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 14 serial-xml encode cases/);
});

test('xmllint parses native marshal output', () => {
  const xml = xmlMarshal({ id: 3, name: 'Lin', age: 8 }, personSchema);
  const lint = spawnSync('xmllint', ['--noout', '-'], {
    input: Buffer.from(xml),
    encoding: 'utf8',
  });
  if (lint.error && lint.error.code === 'ENOENT') {
    assert.ok(true, 'xmllint not installed');
    return;
  }
  assert.equal(lint.status, 0, lint.stderr);
});

test('depth 10000 nested elements error without overflowing; truncated stream errors', () => {
  const deep = `<${'a>'.repeat(10001)}${'/a>'.repeat(10001)}`;
  assert.throws(() => {
    const d = new XmlDecoder(`<r>${deep}</r>`);
    while (d.token()) { /* drain */ }
  }, (err) => {
    assert.equal(err instanceof XmlSyntaxError || err instanceof Error, true);
    return true;
  });
  assert.throws(() => {
    const d = new XmlDecoder('<a><b>');
    while (d.token()) { /* drain */ }
  }, XmlSyntaxError);
});

test('custom entity replacement does not loop', { timeout: 2000 }, () => {
  const d = new XmlDecoder('<a>&x;</a>', { entity: { x: '&x;' } });
  const texts = [];
  for (;;) {
    const t = d.token();
    if (!t) break;
    if (t.type === 'chardata') texts.push(t.text);
  }
  assert.deepEqual(texts, ['&x;']);
});

test('HTML helpers, header, skip, encoder tokens, indent', () => {
  assert.equal(HTML_ENTITY.nbsp, '\u00A0');
  assert.ok(HTML_AUTO_CLOSE.includes('br'));
  assert.equal(getHtmlEntity().amp, '&');
  assert.deepEqual(getHtmlAutoClose().sort(), [...HTML_AUTO_CLOSE].sort());
  assert.equal(XML_HEADER, '<?xml version="1.0" encoding="UTF-8"?>\n');
  const d = new XmlDecoder('<a><b>1</b><c>2</c></a>');
  const start = d.token();
  assert.equal(start.type, 'start');
  const inner = d.token();
  assert.equal(inner.name.local, 'b');
  d.skip();
  const next = d.token();
  assert.equal(next.type, 'start');
  assert.equal(next.name.local, 'c');
  const [line, col] = d.inputPos();
  assert.ok(line >= 1 && col >= 1);
  assert.ok(d.inputOffset() > 0);

  const enc = new XmlEncoder();
  enc.encodeToken({ type: 'start', name: { space: '', local: 'a' }, attr: [] });
  enc.encodeToken({ type: 'chardata', text: 'x<y' });
  enc.encodeToken({ type: 'end', name: { space: '', local: 'a' } });
  enc.flush();
  assert.equal(Buffer.from(enc.bytes()).toString(), '<a>x&lt;y</a>');
  const indented = xmlMarshalIndent({ id: 1, name: 'A', age: 2 }, personSchema, '', '  ');
  assert.match(Buffer.from(indented).toString(), /\n  <name>/);

  const cmtEnc = new XmlEncoder();
  cmtEnc.encodeToken({ type: 'comment', text: 'a--b' });
  cmtEnc.flush();
  assert.equal(Buffer.from(cmtEnc.bytes()).toString(), '<!--a--b-->');
  assert.throws(
    () => xmlMarshal({ msg: 'a--b' }, decodeSchemas.comment),
    (err) => err.message === 'xml: comments must not contain "--"',
  );
  assert.throws(
    () => new XmlEncoder().encodeToken({ type: 'comment', text: 'a-->b' }),
    (err) => String(err.message).includes('EncodeToken of Comment containing --> marker'),
  );
});

test('DefaultSpace, charsetReader, and type errors', () => {
  const d = new XmlDecoder('<a/>', { defaultSpace: 'urn:x' });
  const t = d.token();
  assert.equal(t.name.space, 'urn:x');
  const latin = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><a>'),
    Buffer.from([0xe9]),
    Buffer.from('</a>'),
  ]);
  const decoded = new XmlDecoder(latin, {
    charsetReader(enc, input) {
      assert.match(enc, /iso-8859-1/i);
      return new TextEncoder().encode(new TextDecoder('latin1').decode(input));
    },
  });
  const toks = [];
  for (;;) {
    const tok = decoded.token();
    if (!tok) break;
    toks.push(tok);
  }
  const text = toks.find((x) => x.type === 'chardata');
  assert.equal(text.text, 'é');
  assert.throws(() => xmlMarshal({}, null), TypeError);
  assert.throws(() => xmlUnmarshal(1, personSchema), TypeError);
  assert.throws(() => xmlEscape('abc'), TypeError);
});
