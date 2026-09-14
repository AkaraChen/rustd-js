import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SuffixArray } from '../index.mjs';

const KB256 = 256 * 1024;
const MB1 = 1024 * 1024;
const MB4 = 4 * 1024 * 1024;
const MB16 = 16 * 1024 * 1024;
/** 4× size may cost up to 8× time (2× slack over linear). Quadratic/naive suffix sort fails this. */
const MAX_RATIO = 8;
/** Two 4× size steps, each capped at 8× time (2× slack), compound to 64×. */
const MAX_RATIO_16_VS_1 = 64;

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

/** 5 timed samples, drop min/max, median of the remaining 3. Shared-host 3-sample medians flake at the 8×/64× caps. */
function trimmedMedianBuild(make, n) {
  const { samples } = medianBuild(make, n, 5);
  const trimmed = samples.slice(1, -1);
  return { median: trimmed[Math.floor(trimmed.length / 2)], samples };
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

function assertNearLinear16(label, times) {
  const t1 = times[MB1].median;
  const t4 = times[MB4].median;
  const t16 = times[MB16].median;
  const r4 = t4 / t1;
  const r16vs4 = t16 / t4;
  const r16vs1 = t16 / t1;
  console.log(JSON.stringify({
    label,
    ms: { '1MB': +t1.toFixed(3), '4MB': +t4.toFixed(3), '16MB': +t16.toFixed(3) },
    ratio: { '4MB/1MB': +r4.toFixed(2), '16MB/4MB': +r16vs4.toFixed(2), '16MB/1MB': +r16vs1.toFixed(2) },
    samples: {
      '1MB': times[MB1].samples.map((x) => +x.toFixed(3)),
      '4MB': times[MB4].samples.map((x) => +x.toFixed(3)),
      '16MB': times[MB16].samples.map((x) => +x.toFixed(3)),
    },
  }));
  assert.ok(t16 < 80000, `${label} 16MB ${t16.toFixed(3)}ms (>=80s)`);
  // 4MB/1MB already covered by checkpoint 6; this slice only checks 16MB vs those baselines.
  assert.ok(r16vs4 <= MAX_RATIO, `${label} 16MB/4MB=${r16vs4.toFixed(2)} (4MB=${t4.toFixed(3)}ms 16MB=${t16.toFixed(3)}ms)`);
  assert.ok(r16vs1 <= MAX_RATIO_16_VS_1, `${label} 16MB/1MB=${r16vs1.toFixed(2)} (1MB=${t1.toFixed(3)}ms 16MB=${t16.toFixed(3)}ms)`);
}

test('SuffixArray.build 1MB/4MB/16MB is near-linear (identical bytes)', { timeout: 180_000 }, () => {
  const times = {
    [MB1]: trimmedMedianBuild(identical, MB1),
    [MB4]: trimmedMedianBuild(identical, MB4),
    [MB16]: trimmedMedianBuild(identical, MB16),
  };
  assertNearLinear16('identical-a-16', times);
});

test('SuffixArray.build 1MB/4MB/16MB is near-linear (patterned bytes)', { timeout: 180_000 }, () => {
  const times = {
    [MB1]: trimmedMedianBuild(patterned, MB1),
    [MB4]: trimmedMedianBuild(patterned, MB4),
    [MB16]: trimmedMedianBuild(patterned, MB16),
  };
  assertNearLinear16('pattern-16', times);
});
