import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { syntaxParse, FLAGS } from '../index.mjs';

const COUNT = Number(process.env.RUSTD_BENCH_COUNT ?? 10000);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parse.json', import.meta.url), 'utf8'));
const base = fixture.cases.filter((c) => !c.patternHex);

function generated(i) {
  switch (i % 7) {
    case 0:
      return { pattern: `x${i}y*`, flags: FLAGS.Perl };
    case 1:
      return { pattern: `(a|b){${i % 8}}`, flags: FLAGS.Perl };
    case 2:
      return { pattern: `[[:alnum:]]+z${i}`, flags: FLAGS.POSIX };
    case 3:
      return { pattern: `\\p{L}+_${i}`, flags: FLAGS.Perl };
    case 4:
      return { pattern: `(?:ab)+c{${1 + (i % 5)}}`, flags: FLAGS.Perl };
    case 5:
      return { pattern: `[a-zA-Z0-9._-]{2,${3 + (i % 10)}}`, flags: FLAGS.Perl };
    default:
      return { pattern: `foo|bar|baz${i % 50}`, flags: FLAGS.POSIX };
  }
}

const cases = [];
let i = 0;
const fixtureTarget = Math.floor(COUNT * 0.7);
while (cases.length < fixtureTarget) {
  const c = base[i % base.length];
  cases.push({ pattern: c.pattern, flags: c.flags });
  i += 1;
}
while (cases.length < COUNT) {
  cases.push(generated(cases.length));
}

function parseAll() {
  let ok = 0;
  let errors = 0;
  for (const c of cases) {
    try {
      syntaxParse(c.pattern, c.flags);
      ok += 1;
    } catch {
      errors += 1;
    }
  }
  return { ok, errors };
}

parseAll();
const t0 = performance.now();
const native = parseAll();
const nativeMs = performance.now() - t0;

const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
const prefix = process.env.RUSTD_GO ? [] : ['exec', '--', 'go'];
const root = resolve(import.meta.dirname, '../../..');
const go = spawnSync(command, [...prefix, 'run', '.', '-bench-parse'], {
  cwd: resolve(root, 'packages/rustd-regexsyntax/gofixtures'),
  encoding: 'utf8',
  input: JSON.stringify({ schema: 1, cases }),
  maxBuffer: 32 << 20,
  timeout: 120000,
  env: { ...process.env, GOWORK: 'off' },
});
if (go.error) throw go.error;
if (go.status !== 0) throw new Error(go.stderr || `go bench-parse status ${go.status}`);
const goStats = JSON.parse(go.stdout);

const report = {
  date: new Date().toISOString().slice(0, 10),
  node: process.version,
  goVersion: '1.24.13',
  platform: `${process.platform}-${process.arch}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  method: `One sequential pass of ${COUNT} mixed syntax.Parse cases after one warmup pass; 70% cycled Go parse fixtures (no invalid UTF-8 bytes), 30% generated Perl/POSIX patterns; shared host, not an isolated benchmark. Native includes napi-rs + JS SyntaxRegexp materialization.`,
  count: COUNT,
  native: {
    ok: native.ok,
    errors: native.errors,
    ms: Number(nativeMs.toFixed(3)),
    parsesPerSec: Math.round(COUNT / (nativeMs / 1000)),
  },
  reference: {
    ok: goStats.ok,
    errors: goStats.errors,
    ms: Number(Number(goStats.ms).toFixed(3)),
    parsesPerSec: Math.round(goStats.parsesPerSec),
  },
};
console.log(JSON.stringify(report, null, 2));
