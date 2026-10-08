import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {ProjectRuns} from '../src/main/project-runs.mjs';
import {initProjectRuns} from '../src/renderer/js/project-runs.mjs';

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

// Exercise the renderer's real start handler with a delayed IPC reply. Backend
// readiness and obsolete replies must not steal the user's current workspace.
const priorDocument = globalThis.document, priorWindow = globalThis.window;
const cleanups = [];
globalThis.document = {
  querySelectorAll: () => [],
  createElement: () => ({dataset:{}, setAttribute() {}}),
};
globalThis.window = {addEventListener: (_type, cleanup) => cleanups.push(cleanup)};
try {
  const renderer = () => {
    let state = {cwd:'C:/project-a',sessionId:'one'}, notify, finish, start, previewIntent = 0;
    const opened = [];
    const ui = initProjectRuns({
      api: {
        onProjectRun: listener => { notify = listener; },
        projectRunList: async () => ({ok:true,data:[]}),
        projectRunStart: () => new Promise(resolve => { finish = resolve; }),
      },
      context: () => state,
      switchProject: async cwd => { state = {...state,cwd}; },
      openPreview: (url, run) => opened.push({url,run}),
      capturePreviewIntent: () => { const intent = previewIntent; return () => intent === previewIntent; },
      showLogs() {}, toast: message => { throw Error(message); },
    });
    ui.mount({querySelector: selector => selector === '.project-new'
      ? {before: button => {start=button;}}
      : {after() {}}}, {cwd:state.cwd});
    const run = {id:'renderer-run',cwd:state.cwd,sessionId:state.sessionId,status:'running',urls:[url]};
    return {opened,run,start:()=>start.onclick(),complete:()=>finish({ok:true,data:run}),
      notify:()=>notify(run),setState:next=>{state=next;},changePreview:()=>{previewIntent++;}};
  };
  const background = renderer();
  background.notify();
  assert.equal(background.opened.length,0,'Running push must not automatically open preview');
  await background.start();
  assert.equal(background.opened.length,1,'Clicking an already running project still opens it');
  const same = renderer(), sameStart = same.start();
  same.complete(); await sameStart;
  assert.equal(same.opened.length,1,'Immediate running result may open for the initiating session');
  for (const next of [{cwd:'C:/project-b',sessionId:'one'},{cwd:'C:/project-a',sessionId:'two'}]) {
    const stale = renderer(), starting = stale.start();
    stale.setState(next); stale.complete(); await starting;
    assert.equal(stale.opened.length,0,'A delayed reply must not open after project or session changes');
  }
  const cancelled = renderer(), cancelledStart = cancelled.start();
  cancelled.changePreview(); cancelled.complete(); await cancelledStart;
  assert.equal(cancelled.opened.length,0,'A delayed reply must respect a newer collapse or preview choice');
  console.log('PASS explicit project preview, background readiness, newer preview choice and delayed launch reply isolation');
} finally {
  cleanups.forEach(cleanup=>cleanup());
  if(priorDocument===undefined)delete globalThis.document;else globalThis.document=priorDocument;
  if(priorWindow===undefined)delete globalThis.window;else globalThis.window=priorWindow;
}
