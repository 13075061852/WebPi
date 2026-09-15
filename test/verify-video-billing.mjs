import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoSettings } from '../src/main/video-settings.mjs';
import { VideoGeneration } from '../src/main/video-generation.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-billing-'));
try {
  const settings = new VideoSettings(path.join(root,'settings.json'), {seal:v=>v,unseal:v=>v});
  settings.save({provider:'apimart',model:'seedance-2.0-mini',resolution:'720P',duration:5,apiKey:'test',setDefault:true});
  let now = 10000, creates = 0, downloads = 0, queries = 0, amount = 1.144;
  const originalQuote = {available:true,rate:0.2288,total:1.144,currency:'Credits',unit:'second',updatedAt:now};
  const service = new VideoGeneration(settings,path.join(root,'jobs.json'), { confirmGeneration: async () => true,
    now:()=>now, pricing:{estimate:async input=>{assert.equal(input.duration,5);assert.equal(input.model,'seedance-2.0-mini');return structuredClone(originalQuote);}},
    providers:{apimart:{
      create:async()=>{creates++;now=12000;return 'task-1';},
      query:async()=>{queries++;now=139000;return {status:'succeeded',url:'https://cdn.example.test/video.mp4',usage:{amount,unit:'Credits'},generationMs:126000,billing:{source:'credits_cost',credits_cost:amount}};}
    }},
    fetchImpl:async()=>{downloads++;now=140000;return new Response(Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(40)]));}
  });
  const result = await service.run('generate-1',{action:'generate',prompt:'test'},root);
  assert.deepEqual(result.timing,{submissionMs:2000,generationMs:127000,platformMs:126000,downloadMs:1000,totalMs:130000});
  assert.equal(result.billing.delta,0);
  assert.equal(result.billing.requested.duration,5);
  assert.equal(result.billing.platform.source,'credits_cost');
  assert.equal(result.billing.estimate.total,1.144);
  originalQuote.total=100;
  amount=1;
  const refreshed=await service.run('status-1',{action:'status',task_id:'task-1'},root);
  assert.equal(refreshed.usage.amount,1);
  assert.equal(refreshed.billing.estimate.total,1.144,'Settlement refresh must keep submission price snapshot');
  assert.equal(refreshed.billing.delta,-0.144);
  assert.deepEqual(refreshed.timing,result.timing,'Status refresh must not change generation duration');
  assert.equal(creates,1);assert.equal(downloads,1);assert.equal(queries,2);
  await service.run('generate-1',{action:'generate',prompt:'test'},root);
  assert.equal(creates,1);assert.equal(queries,2,'Duplicate generate is still idempotent');
  service.pricing.estimate=()=>new Promise(()=>{});
  service.providers.apimart.create=async()=>{creates++;return 'task-2';};
  const noQuote=await service.run('generate-2',{action:'generate',prompt:'test'},root);
  assert.ok(noQuote.file,'An unavailable public quote must not delay video delivery');
  assert.equal(noQuote.billing.estimate,null);
  assert.equal(noQuote.usage.amount,1);
  console.log('PASS stage timing, original quote snapshot, settled cost refresh, no duplicate generation/download and non-blocking prices');
} finally {
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('halo-video-billing-'));
  fs.rmSync(root,{recursive:true,force:true});
}
