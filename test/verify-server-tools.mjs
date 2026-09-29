import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {serverTools,copyServerFile} from '../src/main/server-tools.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-server-tools-'));
const rows=[{id:'us',name:'美国',secret:'never expose'},{id:'hk',name:'香港'}], executed=[];
const clients=new Map();
for(const id of ['us','hk']) {
 const root=path.join(dir,id);fs.mkdirSync(root);
 const file=p=>path.join(root,p);
 clients.set(id,{sftp:cb=>cb(null,{
   lstat:(p,done)=>fs.lstat(file(p),(err,stat)=>{if(err?.code==='ENOENT')err.code=2;done(err,stat);}),
   createReadStream:p=>fs.createReadStream(file(p)),createWriteStream:(p,opts)=>fs.createWriteStream(file(p),opts),
   rename:(a,b,done)=>{if(fs.existsSync(file(b)))return done(Error('exists'));fs.rename(file(a),file(b),done);},
   unlink:(p,done)=>fs.unlink(file(p),done),end:()=>{}
 })});
}
const manager={list:()=>rows,clients,connect:async()=>{},exec:async(id,command)=>{executed.push({id,command});return {code:0,output:id};}};
const tools=serverTools(()=>manager,()=> 'us');
try {
 const list=await tools[0].execute(); assert.equal(JSON.stringify(list).includes('never expose'),false);assert.equal(list.details.servers[0].current,true);
 await tools[1].execute('',{command:'pwd'});await tools[1].execute('',{command:'pwd',serverId:'hk'});assert.deepEqual(executed.map(r=>r.id),['us','hk']);
 await assert.rejects(tools[1].execute('',{command:'pwd',serverId:'missing'}),/不存在/);
 fs.writeFileSync(path.join(dir,'us','source'),Buffer.from([0,255,1,2]));
 const args={sourceServerId:'us',targetServerId:'hk',sourcePath:'/source',targetPath:'/stage'};
 const copied=await tools[2].execute('',args);assert.equal(copied.details.bytes,4);assert.deepEqual(fs.readFileSync(path.join(dir,'hk','stage')),Buffer.from([0,255,1,2]));
 await assert.rejects(copyServerFile(manager,args),/已存在/);assert.deepEqual(fs.readFileSync(path.join(dir,'hk','stage')),Buffer.from([0,255,1,2]));
 await assert.rejects(copyServerFile(manager,{...args,sourcePath:'relative'}),/绝对路径/);
 const abort=new AbortController();abort.abort();await assert.rejects(copyServerFile(manager,{...args,targetPath:'/cancelled'},abort.signal));assert.equal(fs.existsSync(path.join(dir,'hk','cancelled')),false);
 await assert.rejects(copyServerFile(manager,{...args,sourcePath:'/missing',targetPath:'/failed'}));assert.deepEqual(fs.readdirSync(path.join(dir,'hk')),['stage']);
 console.log('PASS server tools: safe inventory, default/explicit targets, invalid IDs, binary transfer, overwrite protection, cancellation and failures');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
