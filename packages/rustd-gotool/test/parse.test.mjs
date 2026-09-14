import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  FileSet,
  PARSE_MODE,
  parseFile,
  parseExpr,
  astFprint,
  astInspect,
  astIsExported,
  astNewIdent,
  UnsupportedFeatureError,
} from '../index.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixturePath = new URL('./parse-fixtures.json', import.meta.url);

function go(args = [], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
  return spawnSync(command, [...prefix, 'run', './tools/gofixtures/gotool', ...args], {
    cwd: root, encoding: 'utf8', input, maxBuffer: 64 << 20, timeout: 120000,
  });
}

function fprint(fset, node) {
  const chunks = [];
  astFprint({ write(c) { chunks.push(Buffer.from(c)); } }, fset, node);
  return Buffer.concat(chunks).toString('utf8');
}

test('Go parse fixture dump is stable and native ast.Fprint matches byte-for-byte', () => {
  const generated = go(['-parse']);
  assert.equal(generated.status, 0, generated.stderr);
  const committed = readFileSync(fixturePath, 'utf8');
  assert.equal(generated.stdout, committed, 'Go parse fixture drift');
  const fixture = JSON.parse(committed);
  assert.equal(fixture.package, 'gotool-parse');
  assert.equal(fixture.go, 'go1.24.13');
  assert.ok(fixture.cases.length >= 10);
  for (const c of fixture.cases) {
    const src = Buffer.from(c.srcB64, 'base64');
    const fset = new FileSet();
    const node = c.kind === 'expr'
      ? parseExpr(fset, src.toString('utf8'), c.mode)
      : parseFile(fset, c.filename, src, c.mode);
    const got = fprint(fset, node);
    if (got !== c.fprint) {
      const a = got.split('\n');
      const b = c.fprint.split('\n');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      assert.equal(got, c.fprint, `${c.id} fprint mismatch at line ${i + 1}\nwant: ${b[i]}\ngot:  ${a[i]}`);
    }
  }
});

test('JS extra sources Fprint then Go verifies the dump packet', () => {
  const extras = [
    ['js-hello', 'h.go', 'file', 'package main\nfunc main() { println(1) }\n'],
    ['js-type', 't.go', 'file', 'package p\ntype N int\n'],
    ['js-expr', '', 'expr', 'a.b(1, 2)'],
  ];
  const mode = PARSE_MODE.ParseComments | PARSE_MODE.SkipObjectResolution;
  const cases = extras.map(([id, filename, kind, text]) => {
    const src = Buffer.from(text);
    const fset = new FileSet();
    const node = kind === 'expr' ? parseExpr(fset, text, mode) : parseFile(fset, filename, src, mode);
    return {
      id,
      filename,
      srcB64: src.toString('base64'),
      mode,
      kind,
      fprint: fprint(fset, node),
      errors: [],
    };
  });
  const packet = { schema: 1, package: 'gotool-parse', go: 'js', cases };
  const verified = go(['-verify-parse'], JSON.stringify(packet));
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Go verified 3 gotool-parse cases/);
});

test('src=null is unsupported; inspect/newIdent/isExported work', () => {
  const fset = new FileSet();
  assert.throws(() => parseFile(fset, 'x.go', null, 0), UnsupportedFeatureError);
  const id = astNewIdent('Fmt');
  assert.equal(id.nodeType, 'Ident');
  assert.equal(astIsExported(id.name), true);
  const src = Buffer.from('package p\nfunc F() {}\n');
  const file = parseFile(fset, 'p.go', src, PARSE_MODE.SkipObjectResolution);
  const types = [];
  astInspect(file, (n) => { types.push(n.nodeType); });
  assert.ok(types.includes('File'));
  assert.ok(types.includes('FuncDecl'));
});
