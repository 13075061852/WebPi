/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import net from 'node:net';
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from 'node:url';

const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const PORT = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const fixture = mkdtempSync(path.join(tmpdir(), 'halo-timeline-'));
const agent = path.join(fixture, 'agent'), profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace');
for (const directory of [agent, profile, workspace]) mkdirSync(directory);
writeFileSync(path.join(agent, 'auth.json'), '{}');
writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
writeFileSync(path.join(fixture, 'gitconfig'), '');
writeFileSync(path.join(fixture, 'npmrc'), '');
const bootstrap = path.join(fixture, 'bootstrap.cjs');
writeFileSync(bootstrap, `
Object.defineProperty(globalThis, 'fetch', { configurable: true, get: () => async () => { throw Error('Network disabled by timeline regression'); }, set: () => {} });
const { app, session } = require('electron');
app.once('ready', () => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })));
import(${JSON.stringify(pathToFileURL(path.resolve('src/main/main.mjs')).href)}).catch(error => { console.error(error); process.exitCode = 1; });
`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE|PROXY|^GIT_|^GH_|^GCM_|^SSH_|^NODE_OPTIONS$)/i.test(key)));
Object.assign(env, {
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  XDG_CONFIG_HOME: path.join(fixture, 'config'), XDG_CACHE_HOME: path.join(fixture, 'cache'), GH_CONFIG_DIR: path.join(fixture, 'gh'),
  GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GCM_CREDENTIAL_STORE: 'plaintext', GCM_PLAINTEXT_STORE_PATH: path.join(fixture, 'empty-gcm-store'), GCM_INTERACTIVE: 'never',
  NPM_CONFIG_USERCONFIG: path.join(fixture, 'npmrc'), TEMP: fixture, TMP: fixture, NO_PROXY: '*',
  PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_HALO_PI_PATH: path.resolve('test/fixtures/pi-sdk.js'),
});
const electron = spawn(
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron",
  [bootstrap, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`],
  { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true }
);
electron.stdout.on("data", () => {});
electron.stderr.on("data", () => {});
electron.on("exit", (c) => console.log("electron exited", c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findMainPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const main = list.find((t) => t.type === "page" && t.url.endsWith("index.html"));
      if (main) return main;
    } catch {}
    await sleep(500);
  }
  throw new Error("main window not found");
}

const main = await findMainPage();
console.log("connected:", main.title);
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleLogs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
function send(method, params = {}, sessionId) {
  return new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evalJS(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
async function screenshot(file) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  console.log("saved", file);
}

await send("Runtime.enable");
await send("Page.enable");

// wait for the app + debug hook
let ready = false;
for (let i = 0; i < 30; i++) {
  try { ready = await evalJS("!!window.__haloDispatch"); } catch {}
  if (ready) break;
  await sleep(500);
}
if (!ready) throw new Error("__haloDispatch not available");
console.log("app ready, injecting scenarios...");

// make the layout deterministic for the shot
await evalJS(`
  document.body.classList.add('enter');
`);


try {
 await sleep(1200);
 const live=await evalJS(`(()=>{
 const d=window.__haloDispatch; d({type:'agent_start'});
 const checks=[];
 for(let i=0;i<7;i++){
 if(i===0||i===3){
 const message={role:'assistant',content:[{type:'text',text:'阶段进度 '+i}]};
 d({type:'message_start',message});d({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'阶段进度 '+i}});d({type:'message_end',message});
 }
 d({type:'tool_execution_start',toolCallId:'compact-'+i,toolName:'read',args:{path:'file-'+i}});
 // Leave the seventh tool running, so its delayed updates can arrive after
 // another tool starts without changing which step is newest.
 if(i!==6)d({type:'tool_execution_end',toolCallId:'compact-'+i,isError:i===2,result:{content:[{type:'text',text:'result '+i}]}});
 const turn=document.querySelector('.turn');
 checks.push({visible:turn.querySelectorAll(':scope > .tool').length,archived:turn.querySelectorAll('.tool-history .tool').length,latest:turn.querySelector(':scope > .tool .tool-arg')?.textContent,empty:!!turn.querySelector('.tool-history .process-body:empty'),groups:turn.querySelectorAll('.tool-history').length});
 }
 const turn=document.querySelector('.turn');
 return {checks,visible:turn.querySelectorAll(':scope > .tool').length, archived:turn.querySelectorAll('.tool-history .tool').length,statusAtTop:!!turn.querySelector(':scope > .turn-status'),texts:turn.querySelectorAll(':scope > .md').length,groups:[...turn.querySelectorAll('.tool-history')].map(group=>({count:group.querySelectorAll('.tool').length,afterText:group.previousElementSibling.matches('.md')})),oldLabel:turn.textContent.includes('较早的过程'),open:turn.querySelector('.tool-history').open};
 })()`);
 assert.equal(live.checks[0].groups,0,'The first visible step must not create an empty history fold');
 for(const [index,step] of live.checks.entries())assert.deepEqual({visible:step.visible,archived:step.archived,latest:step.latest,empty:step.empty},{visible:1,archived:index,latest:'file-'+index,empty:false});
 if(live.visible!==1||live.archived!==6||live.texts!==2||live.groups.length!==2||live.groups[0].count!==3||live.groups[1].count!==3||live.groups.some(group=>!group.afterText)||live.open||!live.statusAtTop||live.oldLabel)throw Error(JSON.stringify(live));
 const active=await evalJS(`(()=>{
 const d=window.__haloDispatch,turn=document.querySelector('.turn'),older=turn.querySelector(':scope > .tool');
 d({type:'tool_execution_start',toolCallId:'active-animation',toolName:'bash',args:{command:'echo animation'}});
 const latest=turn.querySelector(':scope > .tool');
 d({type:'tool_execution_update',toolCallId:'compact-6',partialResult:{content:[{type:'text',text:'late progress'}]}});
 const updated=older.querySelector('.tool-out').textContent;
 for(let i=0;i<2;i++)d({type:'tool_execution_end',toolCallId:'compact-6',result:{content:[{type:'text',text:'late result'}]}});
 const groups=[...turn.querySelectorAll('.tool-history')],status=turn.querySelector('.turn-status-text');
 return {visible:turn.querySelectorAll(':scope > .tool').length,archived:turn.querySelectorAll('.tool-history .tool').length,same:latest===turn.querySelector(':scope > .tool'),latest:latest.querySelector('.tool-arg').textContent,running:latest.classList.contains('running'),updated,ended:older.querySelector('.tool-out').textContent,olderArchived:!!older.closest('.tool-history'),activeHistory:groups.some(group=>group.classList.contains('is-running')),animation:getComputedStyle(status).animationName,gradient:getComputedStyle(status).backgroundImage};
 })()`);
 assert.deepEqual({...active,animation:undefined,gradient:undefined},{visible:1,archived:7,same:true,latest:'echo animation',running:true,updated:'late progress',ended:'late result',olderArchived:true,activeHistory:false,animation:undefined,gradient:undefined});
 assert.equal(active.animation,'statusTextFlow');
 assert.ok(active.gradient.includes('linear-gradient'));
 await screenshot('test/shot-progress-folds.png');
 await evalJS(`window.__haloDispatch({type:'tool_execution_end',toolCallId:'active-animation',result:{content:[]}})`);
 await sleep(600); // A status ticker must not re-hide or duplicate the newest completed step.
 assert.deepEqual(await evalJS(`(()=>{const turn=document.querySelector('.turn');return {visible:turn.querySelectorAll(':scope > .tool.done').length,archived:turn.querySelectorAll('.tool-history .tool').length,activeHistory:!!turn.querySelector('.tool-history.is-running')};})()`),{visible:1,archived:7,activeHistory:false});
 const ended=await evalJS(`(()=>{
 const d=window.__haloDispatch;
 const message={role:'assistant',content:[{type:'text',text:'最终完成'}]};d({type:'message_start',message});d({type:'message_end',message});
 d({type:'agent_settled'});
 const turn=document.querySelector('.turn');
 return {visible:turn.querySelectorAll(':scope > .tool').length,archived:turn.querySelectorAll('.process-group .tool').length,open:turn.querySelector('.process-group').open,nested:turn.querySelectorAll('.tool-history').length,active:turn.querySelectorAll('.is-running').length,final:turn.querySelector(':scope > .md')?.textContent,progress:turn.querySelectorAll('.process-body > .md').length};
 })()`);
 if(ended.visible!==0||ended.archived!==8||ended.open||ended.nested||ended.active||ended.final!=='最终完成'||ended.progress!==2)throw Error(JSON.stringify(ended));

 // Restore an in-flight session: completed history remains folded, the real
 // newest card is visible, and subsequent events keep updating that card.
 const running={state:{ready:true,isStreaming:true,sessionId:'timeline-restore',cwd:workspace},seq:20,startedAt:Date.now()-5000,activeTools:{restored:'bash'},messages:[
   {role:'user',content:[{type:'text',text:'恢复执行过程'}]},
   {role:'assistant',content:[{type:'text',text:'阶段进度'},{type:'toolCall',id:'history',name:'read',arguments:{path:'history.txt'}}]},
   {role:'toolResult',toolCallId:'history',content:[{type:'text',text:'saved result'}]},
   {role:'assistant',content:[{type:'toolCall',id:'restored',name:'bash',arguments:{command:'restored command'}}]},
 ]};
 await evalJS('window.__haloRestoreView('+JSON.stringify(running)+')');
 assert.deepEqual(await evalJS(`(()=>{const turn=document.querySelector('.turn');return {visible:turn.querySelectorAll(':scope > .tool.running').length,archived:turn.querySelectorAll('.tool-history .tool.done').length,latest:turn.querySelector(':scope > .tool .tool-arg').textContent,open:turn.querySelector('.tool-history').open};})()`),{visible:1,archived:1,latest:'restored command',open:false});
 const thought=await evalJS(`(()=>{
 const d=window.__haloDispatch,turn=document.querySelector('.turn'),restored=turn.querySelector(':scope > .tool');
 d({type:'tool_execution_end',toolCallId:'restored',result:{content:[{type:'text',text:'restored result'}]}});
 d({type:'message_start',message:{role:'assistant',content:[]}});
 d({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'分析下一步'}});
 d({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'，确认结果'}});
 return {tools:turn.querySelectorAll(':scope > .tool').length,thinking:turn.querySelectorAll(':scope > .think').length,archived:turn.querySelectorAll('.tool-history .tool').length,updated:restored.querySelector('.tool-out').textContent,same:turn.querySelector('.tool-history .tool:last-child')===restored,open:turn.querySelector(':scope > .think').open};
 })()`);
 assert.deepEqual(thought,{tools:0,thinking:1,archived:2,updated:'restored result',same:true,open:true});
 // The final assistant message repeats already streamed thinking. It must
 // close the same node rather than restoring a second copy.
 const thinkingEnd=await evalJS(`(()=>{
 const d=window.__haloDispatch,turn=document.querySelector('.turn'),thinking=turn.querySelector(':scope > .think');
 d({type:'message_end',message:{role:'assistant',content:[{type:'thinking',thinking:'分析下一步，确认结果'}]}});
 const preserved=turn.querySelector(':scope > .think')===thinking&&!thinking.open;
 d({type:'tool_execution_start',toolCallId:'after-thinking',toolName:'read',args:{path:'after-thinking.txt'}});
 return {preserved,visible:turn.querySelectorAll(':scope > .tool').length,thinking:turn.querySelectorAll('.think').length,archived:turn.querySelectorAll('.tool-history .think').length,latest:turn.querySelector(':scope > .tool .tool-arg').textContent};
 })()`);
 assert.deepEqual(thinkingEnd,{preserved:true,visible:1,thinking:1,archived:1,latest:'after-thinking.txt'});
 await evalJS(`(()=>{const d=window.__haloDispatch;d({type:'tool_execution_end',toolCallId:'after-thinking',result:{content:[]}});d({type:'message_start',message:{role:'assistant',content:[]}});d({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'最终答复'}});})()`);
 assert.deepEqual(await evalJS(`(()=>{const turn=document.querySelector('.turn');return {visible:turn.querySelectorAll(':scope > .tool').length,texts:turn.querySelectorAll(':scope > .md').length};})()`),{visible:1,texts:2});
 await evalJS(`(()=>{const d=window.__haloDispatch;d({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'最终答复'}]}});d({type:'agent_settled'});})()`);
 assert.deepEqual(await evalJS(`(()=>{const turn=document.querySelector('.turn');return {visible:turn.querySelectorAll(':scope > .tool, :scope > .think').length,tools:turn.querySelectorAll('.process-body > .tool').length,thinking:turn.querySelectorAll('.process-body > .think').length,groups:turn.querySelectorAll('.process-group').length,open:turn.querySelector('.process-group').open,final:turn.querySelector(':scope > .md').textContent};})()`),{visible:0,tools:3,thinking:1,groups:1,open:false,final:'最终答复'});
 await evalJS('window.__haloRestoreView('+JSON.stringify({...running,state:{...running.state,isStreaming:false},activeTools:{}})+')');
 assert.deepEqual(await evalJS(`(()=>{const turn=document.querySelector('.turn');return {visible:turn.querySelectorAll(':scope > .tool').length,tools:turn.querySelectorAll('.process-body > .tool').length,open:turn.querySelector('.process-group').open,complete:turn.classList.contains('complete')};})()`),{visible:0,tools:2,open:false,complete:true});
 console.log('PASS newest execution step remains visible through updates, thinking and live restore; history and completed turns stay folded');
} finally {ws.close();electron.kill();}
