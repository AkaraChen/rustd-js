import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { createHash, createHmac, availableAlgos } from '../index.mjs';
const command = process.env.RUSTD_GO === 'path' ? 'go' : (process.env.RUSTD_GO ?? 'mise');
const prefix = process.env.RUSTD_GO ? [] : ['exec','--','go'];
const reference=spawnSync(command,[...prefix,'run','./tools/gofixtures/crypto','-bench'],{
  cwd:resolve(import.meta.dirname,'../../..'),encoding:'utf8',env:{...process.env,GOTOOLCHAIN:'go1.25.0'},
});
if(reference.error) throw reference.error;
if(reference.status!==0) throw Error(reference.stderr);
const go=JSON.parse(reference.stdout);
const data=Uint8Array.from({length:65536},(_,i)=>(i*31+17)&255);
const key=new Uint8Array(131).fill(73);
const throughput=ms=>Math.round(128/(ms/1000));
const rows=availableAlgos().map(algorithm=>{
  const g=go.find(r=>r.algorithm===algorithm);
  const measure=make=>{
    const h=make(); const start=performance.now();
    for(let i=0;i<2048;i++) h.update(data);
    h.digest();return performance.now()-start;
  };
  return {algorithm,nativeHashMiBs:throughput(measure(()=>createHash(algorithm,{allowLegacy:true}))),
    goHashMiBs:throughput(g.hashMs),nativeHmacMiBs:throughput(measure(()=>createHmac(algorithm,key,{allowLegacy:true}))),goHmacMiBs:throughput(g.hmacMs)};
});
console.log(JSON.stringify({date:new Date().toISOString().slice(0,10),node:process.version,go:'1.25.0',
  platform:`${process.platform}-${process.arch}`,cpu:cpus()[0].model,
  method:'One sequential pass, 128 MiB per operation, 64 KiB chunks; shared host, not an isolated benchmark.',rows},null,2));
