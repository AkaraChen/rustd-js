import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SuffixArray } from '../index.mjs';

const KB256 = 256 * 1024;
const MB1 = 1024 * 1024;
const MB4 = 4 * 1024 * 1024;
/** 4× size may cost up to 8× time (2× slack over linear). Quadratic/naive suffix sort fails this. */
const MAX_RATIO = 8;

function identical(n) {
  return new Uint8Array(n).fill(97);
}

function patterned(n) {
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = (i * 131 + (i >> 8)) & 255;
  return data;
}

function buildMs(data) {
  const t0 = performance.now();
  const ix = SuffixArray.build(data);
  const ms = performance.now() - t0;
  assert.equal(ix.length, data.length);
  ix.dispose();
  return ms;
}

function medianBuild(make, n, runs = 3) {
  buildMs(make(n));
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(buildMs(make(n)));
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)], samples };
}

function assertNearLinear(label, times) {
  const t256 = times[KB256].median;
  const t1 = times[MB1].median;
  const t4 = times[MB4].median;
  const r1 = t1 / t256;
  const r4 = t4 / t1;
  assert.ok(t1 < 5000, `${label} 1MB ${t1.toFixed(3)}ms (>=5s; naive SA?)`);
  assert.ok(t4 < 20000, `${label} 4MB ${t4.toFixed(3)}ms (>=20s)`);
  assert.ok(r1 <= MAX_RATIO, `${label} 1MB/256KB=${r1.toFixed(2)} (256KB=${t256.toFixed(3)}ms 1MB=${t1.toFixed(3)}ms)`);
  assert.ok(r4 <= MAX_RATIO, `${label} 4MB/1MB=${r4.toFixed(2)} (1MB=${t1.toFixed(3)}ms 4MB=${t4.toFixed(3)}ms)`);
  console.log(JSON.stringify({
    label,
    ms: { '256KB': +t256.toFixed(3), '1MB': +t1.toFixed(3), '4MB': +t4.toFixed(3) },
    ratio: { '1MB/256KB': +r1.toFixed(2), '4MB/1MB': +r4.toFixed(2) },
    samples: {
      '256KB': times[KB256].samples.map((x) => +x.toFixed(3)),
      '1MB': times[MB1].samples.map((x) => +x.toFixed(3)),
      '4MB': times[MB4].samples.map((x) => +x.toFixed(3)),
    },
  }));
}

test('SuffixArray.build 256KB/1MB/4MB is near-linear (identical bytes)', { timeout: 60_000 }, () => {
  const times = {
    [KB256]: medianBuild(identical, KB256),
    [MB1]: medianBuild(identical, MB1),
    [MB4]: medianBuild(identical, MB4),
  };
  assertNearLinear('identical-a', times);
});

test('SuffixArray.build 256KB/1MB/4MB is near-linear (patterned bytes)', { timeout: 60_000 }, () => {
  const times = {
    [KB256]: medianBuild(patterned, KB256),
    [MB1]: medianBuild(patterned, MB1),
    [MB4]: medianBuild(patterned, MB4),
  };
  assertNearLinear('pattern', times);
});
