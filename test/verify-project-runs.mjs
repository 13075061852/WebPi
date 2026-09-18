import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {ProjectRuns} from '../src/main/project-runs.mjs';

const website=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<h1>Project fixture</h1>');});
website.listen(0,'127.0.0.1');await once(website,'listening');
const url=`http://127.0.0.1:${website.address().port}/base/`;
const owner={cwd:process.cwd(),sessionId:'one',sessionFile:'one.jsonl'};
let starts=0;
const manager=new ProjectRuns({analyze:async(run,tools)=>{
  starts++;
  await tools.find(t=>t.name==='project_preview_ready').execute('ready',{url});
}});
try {
  const first=manager.start(owner);
  assert.equal(manager.start(owner).id,first.id);
  await manager.runs.get(first.id).work;
  assert.equal(starts,1);assert.equal(manager.list()[0].status,'running');
  assert.equal(manager.list()[0].urls[0],url);
  await manager.stopSession('other.jsonl');assert.equal(manager.list()[0].status,'running');
  await manager.stopSession('one.jsonl');assert.equal(manager.list()[0].status,'stopped');
  await assert.rejects(manager.ready(manager.runs.get(first.id),url),/取消/);
  const second=manager.start({...owner,sessionId:'two'});await manager.runs.get(second.id).work;
  await assert.rejects(manager.ready(manager.runs.get(second.id),'http://example.com/'),/本机/);
  await assert.rejects(manager.launch(manager.runs.get(second.id),{command:'echo no',cwd:'..'}),/项目内/);
  await manager.stopProject(owner.cwd);assert.ok(manager.list().every(r=>r.status==='stopped'));
  const failure=new ProjectRuns({analyze:async()=>{throw Error('missing dependency');}});
  const failed=failure.start(owner);await failure.runs.get(failed.id).work;
  assert.equal(failure.list()[0].status,'error');assert.match(failure.list()[0].message,/missing dependency/);
  await failure.dispose();
  console.log('PASS duplicate launch, local readiness, owner isolation, stop/cancel, project cleanup and errors');
}finally{await manager.dispose();website.closeAllConnections();await new Promise(resolve=>website.close(resolve));}
