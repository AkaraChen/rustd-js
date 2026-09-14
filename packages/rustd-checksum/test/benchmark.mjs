import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { adler32, crc32ieee, fnv32a } from '../index.mjs';

const data = new Uint8Array(1 << 20);
let state = 42;
for (let i = 0; i < data.length; i++) {
  state = Math.imul(1664525, state) + 1013904223;
  data[i] = (state >>> 24) & 255;
}
function bench(name, fn) {
  for (let i = 0; i < 20; i++) fn();
  const n = 1000;
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const ns = Number(process.hrtime.bigint() - start) / n;
  const mbps = (1000 * 1000) / (ns / 1e9) / (1 << 20);
  return { name, loops: n, nsPerOp: Math.round(ns), mbps: Number(mbps.toFixed(2)) };
}
const native = [
  bench('crc32-ieee', () => crc32ieee(data)),
  bench('adler32', () => adler32(data)),
  bench('fnv32a', () => fnv32a(data)),
];
const go = spawnSync('mise', ['exec', '--', 'go', 'run', './bench.go'], {
  cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 120000,
});
const results = { native, goStdout: go.stdout, goStderr: go.stderr, goStatus: go.status };
writeFileSync(new URL('./benchmark-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
