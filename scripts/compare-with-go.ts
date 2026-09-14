import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Result = Record<string, string>;
export interface Fixture { id: string; hex: string; expected: Result; incremental?: Result }
export interface Packet { schema: number; package: string; cases: Fixture[] }
export type Evaluate = (data: Uint8Array, incremental: boolean) => Result;
const root = resolve(import.meta.dirname, '..');
export function go(args: string[], input?: string) {
  // CI supplies Go on PATH; local builds use the explicitly selected mise toolchain.
  const command = process.env.RUSTD_GO === 'path' ? 'go' : 'mise';
  const prefix = command === 'go' ? [] : ['exec', '--', 'go'];
  const result = spawnSync(command, [...prefix, 'run', './tools/gofixtures', ...args], {
    cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Go exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}
export function fixtures(pkg: string): Packet {
  return JSON.parse(go(['-pkg', pkg])) as Packet;
}
export function assertResults(id: string, expected: Result, actual: Result, hex: string) {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) if (expected[key] !== actual[key]) {
    throw new Error(`${id}/${key}: expected ${expected[key]}, got ${actual[key]}; reproduction input hex=${hex}`);
  }
}
export function compareFromGo(packet: Packet, evaluate: Evaluate) {
  for (const c of packet.cases) {
    const bytes = Uint8Array.from(Buffer.from(c.hex, 'hex'));
    assertResults(c.id, c.expected, evaluate(bytes, false), c.hex);
    assertResults(`${c.id}/incremental`, c.incremental ?? c.expected, evaluate(bytes, true), c.hex);
  }
  return packet.cases.length;
}
export function verifyFromJs(pkg: string, evaluate: Evaluate) {
  const cases: Fixture[] = [];
  for (const size of [0, 1, 7, 64, 65, 1024]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 37 + 19) & 255);
    cases.push({ id: `js-${size}`, hex: Buffer.from(bytes).toString('hex'),
      expected: evaluate(bytes, false), incremental: evaluate(bytes, true) });
  }
  return go(['-pkg', pkg, '-verify'], JSON.stringify({ schema: 1, package: pkg, cases }));
}
export function templateAdapter(): Evaluate {
  const require = createRequire(import.meta.url);
  const { echoBytes } = require('../packages/_template') as { echoBytes: (data: Uint8Array) => Uint8Array };
  return data => ({ echo: Buffer.from(echoBytes(data)).toString('hex') });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pkg = process.argv[2] ?? 'template';
  const adapterPath = process.argv[3];
  if (pkg !== 'template' && !adapterPath) throw new Error('Pass a package name and adapter module exporting evaluate');
  const evaluate: Evaluate = adapterPath
    ? (await import(pathToFileURL(resolve(adapterPath)).href)).evaluate
    : templateAdapter();
  console.log(`Go → native: ${compareFromGo(fixtures(pkg), evaluate)} ${pkg} cases passed`);
  process.stdout.write(verifyFromJs(pkg, evaluate));
}
