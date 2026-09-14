import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { packages } from './workspace.mjs';
const limits = { 'rustd-checksum': 1_500_000, 'rustd-crypto': 4_000_000, 'rustd-tls': 6_000_000, 'rustd-http': 5_000_000, 'rustd-image': 3_000_000 };
for (const { dir, manifest } of packages()) {
  const files = readdirSync(dir).filter(f => f.endsWith('.node'));
  if (!files.length) throw new Error(`${manifest.name}: missing .node; run pnpm build`);
  for (const file of files) {
    const bytes = statSync(resolve(dir, file)).size;
    const limit = limits[manifest.name] ?? 2_000_000;
    console.log(`${manifest.name}/${file}: ${bytes} bytes / ${limit}`);
    if (bytes > limit) throw new Error(`${file}: size budget exceeded`);
  }
}
