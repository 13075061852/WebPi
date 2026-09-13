import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PiBridge,HaloStore} from '../src/main/pi-bridge.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-server-scope-'));
const local=path.join(dir,'Link');fs.mkdirSync(local);
fs.writeFileSync(path.join(local,'AGENTS.md'),'UNRELATED_LOCAL_PROJECT_SENTINEL');
const store=new HaloStore(path.join(dir,'settings.json'));
const servers={list:()=>[{id:'hk',name:'Hong Kong',host:'example.invalid',username:'test',port:22}]};
const bridge=new PiBridge(store,{}, {sessionDir:path.join(dir,'sessions')});bridge.servers=servers;
try {
 await bridge.start(local);
 const session=bridge.session;
 session.sessionManager.appendMessage({role:'user',content:[{type:'text',text:'old remote conversation'}],timestamp:Date.now()});
 const file=session.sessionFile,id=session.sessionId;
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,[{type:'session',version:3,id,timestamp:new Date().toISOString(),cwd:local},{type:'message',id:'old-user',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:'old remote conversation'}],timestamp:Date.now()}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 store.set('serverTargets',{[id]:'hk'});store.set('serverSessions',{[file]:{serverId:'hk',file}});
 const restored=new PiBridge(new HaloStore(store.file),{}, {sessionDir:path.join(dir,'restored')});restored.servers=servers;
 try {
  await restored.start(local);await restored.openSession(file);
  assert.equal(PiBridge.normPath(restored.session.sessionManager.getCwd()),PiBridge.normPath(restored.serverWorkspace('hk')));
  assert.equal(restored.serverTargets.get(restored.session.sessionId),'hk');
  assert.ok(restored.session.messages.some(x=>JSON.stringify(x.content).includes('old remote conversation')));
  assert.ok(!restored.session.systemPrompt?.includes('UNRELATED_LOCAL_PROJECT_SENTINEL'));
  console.log('PASS old server conversation retains history/binding and isolates local project directory');
 }finally{await restored.runtime?.dispose();}
}finally{await bridge.runtime?.dispose();}
process.exit(0);
