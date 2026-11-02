import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
let reloads = 0;
const files = [];
const context = vm.createContext({
  URL,
  normPath: p => String(p).replaceAll('\\', '/').toLowerCase(),
  previewService: {serverId:'hk'},
  S: {state:{sessionId:'focused'}, previewFile:null, switchingSession:false},
  document: {querySelector:()=>({getURL:()=>context.currentURL || 'http://127.0.0.1:5173/path', reloadIgnoringCache(){reloads++;}})},
  setPreview: (...args)=>files.push(args),
});
vm.runInContext(source.slice(source.indexOf('function refreshCompletedPreview('), source.indexOf('const portKey =')), context);
const dispatch = (type, serverId='hk', sessionId='background')=>context.refreshCompletedPreview({event:{type},serverId,sessionId});
dispatch('agent_end'); dispatch('tool_execution_end'); dispatch('agent_settled','us');
assert.equal(reloads,0);
dispatch('agent_settled');
assert.equal(reloads,1);
assert.equal(context.previewService.status,'loading');
context.previewService = null;
context.S.previewFile = 'index.html';
dispatch('agent_settled',null); dispatch('agent_settled','hk','focused');
assert.equal(files.length,0);
dispatch('agent_settled',null,'focused');
assert.equal(files.length, 1);
assert.equal(files[0][0], 'index.html');
assert.equal(files[0][1], true);
assert.equal(files[0][2]?.reveal, false, 'Background refresh must not reveal a collapsed preview');
context.S.switchingSession = true;
dispatch('agent_settled',null,'focused');
assert.equal(files.length,1);
context.S.switchingSession = false;
console.log('PASS settled-only refresh, background server matching, local file refresh and session-switch isolation');
