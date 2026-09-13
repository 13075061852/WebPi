import assert from 'node:assert/strict';
import { PiBridge, HaloStore } from '../src/main/pi-bridge.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'halo-server-groups-'));
const bridge=new PiBridge(new HaloStore(path.join(dir,'settings.json')), {}, {sessionDir:path.join(dir,'sessions')});
bridge.servers={list:()=>[{id:'server-a'},{id:'server-b'}]};
try {
 await bridge.start(dir);
 const first=await bridge.newSession('server-a');
 const repeat=await bridge.newSession('server-a');
 assert.equal(first.sessionId,repeat.sessionId);
 const second=await bridge.newSession('server-b');
 assert.notEqual(first.sessionId,second.sessionId);
 const rows=await bridge.serverConversations();
 assert.equal(rows.filter(r=>r.serverId==='server-a').length,1);
 assert.equal(rows.filter(r=>r.serverId==='server-b').length,1);
 console.log('PASS server groups, isolated drafts and duplicate prevention');
} finally {await bridge.runtime?.dispose();}
process.exit(0);
