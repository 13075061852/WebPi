import assert from 'node:assert/strict';
import {readGeneratedImage,imageTool} from '../src/main/image-generation.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
const stream=(events)=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
const done={type:'response.completed'};
const output={type:'response.output_item.done',item:{type:'image_generation_call',result:png.toString('base64')}};
assert.deepEqual((await readGeneratedImage(stream([output,done]))).buffer,png);
await assert.rejects(readGeneratedImage(stream([output])),/完整图片/);
await assert.rejects(readGeneratedImage(stream([{type:'response.failed'}])),/未完成/);
await assert.rejects(readGeneratedImage(new Response('',{status:401})),/重新登录/);
await assert.rejects(readGeneratedImage(stream([{...output,item:{...output.item,result:'YmFk'}},done])),/不是/);
const controller=new AbortController();controller.abort();
await assert.rejects(imageTool('.',async()=>({})).execute('',{prompt:'x'},controller.signal));
await assert.rejects(imageTool('.',async()=>({})).execute('',{prompt:'x'}),/登录/);
await assert.rejects(imageTool('.',async()=>({})).execute('',{prompt:''}),/提示词/);
console.log('PASS image result, incomplete, error, login, invalid bytes, cancellation and validation');
const directory = await fs.mkdtemp(path.join(os.tmpdir(),'halo-image-timing-'));
const originalFetch = globalThis.fetch, originalNow = Date.now;
let file;
try {
  let now = 1000;
  Date.now = () => now;
  globalThis.fetch = async () => { now = 2500; return stream([output,done]); };
  const result = await imageTool(directory,async()=>{ now = 1500; return {access:'fixture',accountId:'fixture'}; }).execute('test',{prompt:'fixture'});
  file = result.details.file;
  assert.deepEqual(result.details.timing,{startedAt:1000,finishedAt:2500,totalMs:1500});
  assert.equal(result.details.sha256,crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'));
  assert.deepEqual(JSON.parse(result.content[0].text).timing,result.details.timing,'Timing must be serialized into conversation history');
} finally {
  globalThis.fetch = originalFetch; Date.now = originalNow;
  if(file) await fs.unlink(file);
  await fs.rmdir(path.join(directory,'output')).catch(()=>{});
  await fs.rmdir(directory);
}
console.log('PASS image end-to-end persisted timing includes credential resolution, response and file save; content identity recorded');
