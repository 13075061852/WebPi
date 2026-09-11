import assert from 'node:assert/strict';
import { PiBridge, HaloStore } from '../src/main/pi-bridge.mjs';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'halo-project-groups-'));
const a=path.join(dir,'a'),b=path.join(dir,'b');mkdirSync(a);mkdirSync(b);
const store=new HaloStore(path.join(dir,'settings.json'));
store.set('projects',[{cwd:a},{cwd:b}]);
const bridge=new PiBridge(store,{}, {sessionDir:path.join(dir,'sessions')});
try {
 await bridge.start(a); const draft=await bridge.newSession();
 const projects=await bridge.projectsList();
 assert.ok(projects.find(p=>p.cwd===a).sessions.some(s=>s.file===draft.sessionFile));
 assert.equal(projects.find(p=>p.cwd===b).sessions.length,0);
 await bridge.newSession('server-only');
 const local=(await bridge.projectsList()).find(p=>p.cwd===a).sessions;
 assert.equal(local.length,1);
 console.log('PASS project conversation grouping, draft visibility and server isolation');
}finally{await bridge.runtime?.dispose();}
process.exit(0);
