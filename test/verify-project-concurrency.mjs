import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PiBridge,HaloStore} from '../src/main/pi-bridge.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-project-concurrency-'));
const a=path.join(dir,'a'),b=path.join(dir,'b');fs.mkdirSync(a);fs.mkdirSync(b);
const bridge=new PiBridge(new HaloStore(path.join(dir,'settings.json')),{}, {sessionDir:path.join(dir,'sessions')});
const releases=[];
try{
 await bridge.start(a);
 const sa=bridge.session,fa=sa.sessionFile;
 // Controlled tasks keep real bridge contexts busy without network timing or billing.
 let aborts=0;
 sa.abort=async()=>{aborts++;};
 sa.prompt=()=>new Promise(r=>releases.push(r));
 const pa=bridge.prompt('A');
 await bridge.switchProject(b);
 const sb=bridge.session,fb=sb.sessionFile;
 assert.notEqual(sa,sb);
 sb.abort=async()=>{aborts++;};
 sb.prompt=()=>new Promise(r=>releases.push(r));
 const pb=bridge.prompt('B');
 await bridge.openSession(fa);assert.equal(bridge.session,sa);
 await bridge.openSession(fb);assert.equal(bridge.session,sb);
 assert.equal(aborts,0);
 releases.forEach(r=>r());await Promise.all([pa,pb]);
 assert.equal(aborts,0);
 assert(!fs.readFileSync(new URL('../src/renderer/js/app.js',import.meta.url),'utf8').includes('任务进行中，无法切换项目'));
 console.log('PASS two busy project contexts, focus switching, both tasks finish without abort; obsolete UI guards absent');
}finally{releases.forEach(r=>r());await bridge.dispose();}
