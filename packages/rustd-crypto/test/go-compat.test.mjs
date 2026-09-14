import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash, createHmac, availableAlgos } from '../index.mjs';
const root = resolve(import.meta.dirname,'../../..');
const legacy = {allowLegacy:true};
const hex = data => Buffer.from(data).toString('hex');
function go(args=[], input) {
  const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
  const prefix = process.env.RUSTD_GO ? [] : ['exec','--','go'];
  const result = spawnSync(command,[...prefix,'run','./tools/gofixtures/crypto',...args],{
    cwd:root, encoding:'utf8', input, maxBuffer:16<<20,
    env:{...process.env,GOTOOLCHAIN:'go1.25.0'}, timeout:120000,
  });
  if(result.error) throw result.error;
  return result;
}
function evaluate(c) {
  const data = Uint8Array.from({length:c.length},(_,i)=>(i*31+c.seed)&255);
  const h = createHash(c.algorithm,legacy);
  const m = createHmac(c.algorithm,Buffer.from(c.keyHex,'hex'),legacy);
  const chunks=[1,2,3,7,64,4096];
  for(let offset=0,i=0;offset<data.length;i++) {
    const end=Math.min(offset+chunks[i%chunks.length],data.length);
    h.update(data.subarray(offset,end));m.update(data.subarray(offset,end));offset=end;
  }
  const hashHex=hex(h.sum()),hmacHex=hex(m.sum());
  const prefix=new Uint8Array([0xde,0xad,0xbe,0xef]);
  const sumHex=hex(h.sum(prefix)),hmacSumHex=hex(m.sum(prefix));
  h.update('后缀\0');m.update('后缀\0');
  return {...c,hashHex,hmacHex,sumHex,hmacSumHex,extendedHex:hex(h.digest()),hmacExtendedHex:hex(m.digest())};
}
test('Go 1.25 regenerates committed fixture bytes; native matches all 64 cases', () => {
  const generated=go(); assert.equal(generated.status,0,generated.stderr);
  const committed=readFileSync(new URL('./go-fixtures.json',import.meta.url),'utf8');
  assert.equal(generated.stdout,committed,'Go fixture drift');
  const fixture=JSON.parse(committed);
  assert.equal(fixture.cases.length,64);
  assert.deepEqual([...new Set(fixture.cases.map(c=>c.algorithm))],availableAlgos());
  for(const c of fixture.cases) assert.deepEqual(evaluate(c),c,`${c.algorithm}/${c.length}`);
});
test('JS generates different inputs → native computes → Go independently verifies; corruptions fail', () => {
  const cases=availableAlgos().flatMap((algorithm,i)=>[0,17,129,8193].map(length=>evaluate({
    algorithm,length,seed:103+i,keyHex:hex(new Uint8Array(i*29).fill(73)),
  })));
  const packet={version:1,cases};
  const verified=go(['-verify'],JSON.stringify(packet));
  assert.equal(verified.status,0,verified.stderr);
  assert.match(verified.stdout,/Go verified 32 native cases/);
  const broken=structuredClone(packet); broken.cases[0].hmacHex='00';
  const rejected=go(['-verify'],JSON.stringify(broken));
  assert.notEqual(rejected.status,0); assert.match(rejected.stderr,/mismatch case 0/);
  assert.notEqual(go(['-verify'],JSON.stringify({version:1,cases:[]})).status,0);
});
