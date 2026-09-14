import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeByExtension, extensionsByType, addExtensionType, MediaTypeError } from '../index.mjs';

test('builtin TypeByExtension table matches Go for web types', () => {
  assert.equal(typeByExtension('.json'), 'application/json');
  assert.equal(typeByExtension('.wasm'), 'application/wasm');
  assert.equal(typeByExtension('.html'), 'text/html; charset=utf-8');
  assert.equal(typeByExtension('.HTML'), 'text/html; charset=utf-8');
  assert.ok(extensionsByType('image/jpeg').includes('.jpg'));
});

test('AddExtensionType requires a leading dot and records the mapping', () => {
  assert.throws(
    () => addExtensionType('no-dot', 'application/x-test'),
    (err) => err instanceof MediaTypeError && err.message === 'mime: extension "no-dot" missing leading dot',
  );
  addExtensionType('.rustdmimetest', 'application/x-rustd-mime-test');
  assert.equal(typeByExtension('.rustdmimetest'), 'application/x-rustd-mime-test');
  assert.ok(extensionsByType('application/x-rustd-mime-test').includes('.rustdmimetest'));
});

test('AddExtensionType success mapping vs Go (text/* charset=utf-8 default)', () => {
  addExtensionType('.ck8plain', 'text/plain');
  assert.equal(typeByExtension('.ck8plain'), 'text/plain; charset=utf-8');
  assert.equal(typeByExtension('.CK8PLAIN'), 'text/plain; charset=utf-8');
  assert.ok(extensionsByType('text/plain').includes('.ck8plain'));

  addExtensionType('.ck8utf8', 'text/plain; charset=utf-8');
  assert.equal(typeByExtension('.ck8utf8'), 'text/plain; charset=utf-8');

  addExtensionType('.ck8latin', 'text/plain; charset=iso-8859-1');
  assert.equal(typeByExtension('.ck8latin'), 'text/plain; charset=iso-8859-1');

  addExtensionType('.ck8app', 'application/x-ck8');
  assert.equal(typeByExtension('.ck8app'), 'application/x-ck8');

  addExtensionType('.ck8upper', 'TEXT/PLAIN');
  assert.equal(typeByExtension('.ck8upper'), 'TEXT/PLAIN');

  addExtensionType('.ck8params', 'text/plain; foo=bar');
  assert.equal(typeByExtension('.ck8params'), '');
  assert.ok(extensionsByType('text/plain').includes('.ck8params'));

  addExtensionType('.CK8MIX', 'text/x-ck8-mix');
  assert.equal(typeByExtension('.CK8MIX'), 'text/x-ck8-mix; charset=utf-8');
  assert.equal(typeByExtension('.ck8mix'), 'text/x-ck8-mix; charset=utf-8');
});

test('ExtensionsByType after AddExtensionType uses ParseMediaType justType (issue #9 §3)', () => {
  addExtensionType('.ck9upper', 'TEXT/PLAIN');
  assert.equal(typeByExtension('.ck9upper'), 'TEXT/PLAIN');
  for (const typ of ['text/plain', 'TEXT/PLAIN', 'text/plain; charset=utf-8']) {
    assert.ok(extensionsByType(typ).includes('.ck9upper'), typ);
  }

  addExtensionType('.ck9params', 'text/plain; foo=bar');
  assert.equal(typeByExtension('.ck9params'), '');
  for (const typ of ['text/plain', 'TEXT/PLAIN', 'text/plain; charset=utf-8']) {
    assert.ok(extensionsByType(typ).includes('.ck9params'), `empty FormatMediaType rewrite still registers ${typ}`);
  }

  addExtensionType('.CK9MIX', 'TEXT/x-ck9');
  assert.equal(typeByExtension('.CK9MIX'), 'TEXT/x-ck9');
  assert.ok(extensionsByType('text/x-ck9').includes('.ck9mix'));
  assert.ok(extensionsByType('TEXT/X-CK9').includes('.ck9mix'));
  assert.equal(extensionsByType('text/x-ck9').includes('.CK9MIX'), false);

  addExtensionType('.ck9mixed', 'Text/plain');
  assert.equal(typeByExtension('.ck9mixed'), 'Text/plain');
  assert.ok(extensionsByType('text/plain').includes('.ck9mixed'));
  assert.ok(extensionsByType('TEXT/PLAIN').includes('.ck9mixed'));

  assert.throws(
    () => extensionsByType('text/plain; charset'),
    (err) => err instanceof MediaTypeError && err.message === 'mime: invalid media parameter',
  );
});

test('AddExtensionType error strings match Go (issue #9 §3)', () => {
  const cases = [
    ['no-dot', 'application/x-test', 'mime: extension "no-dot" missing leading dot'],
    ['txt', 'text/plain', 'mime: extension "txt" missing leading dot'],
    ['', 'text/plain', 'mime: extension "" missing leading dot'],
    ['.ck7slash', 'not a type', 'mime: expected slash after first token'],
    ['.ck7token', 'bogus/', 'mime: expected token after slash'],
    ['.ck7empty', '/plain', 'mime: no media type'],
    ['.ck7param', 'text/plain; charset', 'mime: invalid media parameter'],
    ['.ck7blank', '', 'mime: no media type'],
  ];
  for (const [ext, typ, message] of cases) {
    assert.throws(
      () => addExtensionType(ext, typ),
      (err) => err instanceof MediaTypeError && err.message === message,
      `${JSON.stringify(ext)} ${JSON.stringify(typ)}`,
    );
  }
});
