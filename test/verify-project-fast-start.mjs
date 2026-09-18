import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { ProjectRuns } from '../src/main/project-runs.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-fast-start-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
fs.writeFileSync(path.join(root,'server.cjs'), `require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<h1>Ready</h1>')}).listen(${port},'127.0.0.1');`);
const command = process.platform === 'win32' ? `& '${process.execPath.replaceAll("'", "''")}' ./server.cjs` : `'${process.execPath}' ./server.cjs`;
const url = `http://127.0.0.1:${port}/base/`;
const saved = new Map(), managers = [];
let analyses = 0;
const make = () => {
  const manager = new ProjectRuns({fastWaitMs:1500, readRecipe:cwd=>saved.get(cwd), saveRecipe:(cwd,r)=>saved.set(cwd,structuredClone(r)),
    analyze: async run => {
      analyses++;
      await manager.launch(run,{command,label:'test frontend'});
      for(let i=0;i<30;i++) {
        try { await manager.ready(run,url); return; } catch { await new Promise(resolve=>setTimeout(resolve,100)); }
      }
      throw Error('Fixture server did not start');
    }});
  managers.push(manager); return manager;
};
const owner = {cwd:root,sessionId:'fixture',sessionFile:'fixture.jsonl'};
const start = async manager => { const view=manager.start(owner); const run=manager.runs.get(view.id); await run.work; assert.equal(run.status,'running',run.message); return run; };
try {
  const first=make(); const firstRun=await start(first);
  assert.equal(analyses,1); assert.equal(saved.size,1);
  assert.equal([...saved.values()][0].services[0].command,command);
  await first.stop(firstRun.id);
  const second=make(); const secondRun=await start(second);
  assert.equal(analyses,1,'Saved startup must not invoke AI');
  assert.equal(secondRun.urls[0],url); await second.stop(secondRun.id);
  const recipe=[...saved.values()][0]; recipe.services[0].command=process.platform==='win32'?'exit 7':'exit 7';
  const third=make(); const repaired=await start(third);
  assert.equal(analyses,2,'Failed fast startup invokes AI once');
  assert.ok(repaired.fastError); assert.equal([...saved.values()][0].services[0].command,command);
  await third.stop(repaired.id);
  const fourth=make(); const pending=fourth.start(owner); await fourth.stop(pending.id); await fourth.runs.get(pending.id).work;
  assert.equal(analyses,2,'Cancellation must not start AI');
  assert.equal(fourth.runs.get(pending.id).status,'stopped');
  console.log('PASS real managed server: learn startup, persistent reuse without AI, failed command cleanup/fallback, relearn and cancel');
} finally {
  await Promise.all(managers.map(manager=>manager.dispose()));
  fs.rmSync(root,{recursive:true,force:true});
}
// node-pty's Windows native handles can keep the test host alive after all trees stop.
process.exit(0);
