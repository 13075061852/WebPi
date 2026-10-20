import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {isolatePi} from './helpers/isolated-pi.mjs';
const fixture=isolatePi('halo-update-tasks-');
try {
 const {PiBridge,HaloStore}=await import('../src/main/pi-bridge.mjs');
 const project=path.join(fixture.dir,'project');fs.mkdirSync(project);
 const bridge=new PiBridge(new HaloStore(path.join(fixture.dir,'settings.json')));
 try {
  await bridge.start(project);const first=bridge.session;first.isStreaming=true;
  await bridge.newSession();const second=bridge.session;
  assert.notEqual(first,second);
  assert.equal(bridge.updateTasks().length,1,'Detect the background task even though focused session is idle');
  second.pendingMessageCount=1;assert.equal(bridge.updateTasks().length,2,'Queued messages also prevent updating');
  let cleared=0;
  for(const session of [first,second])session.clearQueue=()=>{cleared++;session.pendingMessageCount=0};
  await bridge.stopForUpdate();assert.equal(cleared,2);assert.equal(bridge.updateTasks().length,0);
 }finally{await bridge.dispose()}
 console.log('PASS all-session update guard and stop: background task, focused queued task, every queue cleared and every session aborted');
}finally{fixture.cleanup()}
