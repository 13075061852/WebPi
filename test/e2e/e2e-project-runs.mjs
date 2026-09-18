// Real Electron startup, retry and single-instance checks using only isolated local fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const executableArgument = process.argv.slice(2).find(value => !value.startsWith('--'));
const executable = path.resolve(executableArgument || 'node_modules/electron/dist/electron.exe');
const packaged = Boolean(executableArgument);
const base = path.resolve('tmp/startup-recovery');
fs.mkdirSync(base, { recursive: true });
const fixture = fs.mkdtempSync(path.join(base, 'run-'));
const agent = path.join(fixture, 'agent'), profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace');
for (const dir of [agent, profile, workspace]) fs.mkdirSync(dir);

fs.writeFileSync(path.join(workspace,'dev-server.cjs'),`const http=require('http'),fs=require('fs');const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<html><title>Project fixture</title><h1>PROJECT_PREVIEW_READY</h1></html>')});server.listen(0,'127.0.0.1',()=>fs.writeFileSync('port.txt',String(server.address().port)));`);
const calls=[];
const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=JSON.parse(raw);calls.push(body);
  const done=body.messages.filter(m=>m.role==='tool').length;
  if(done===0)await new Promise(resolve=>setTimeout(resolve,1600));
  const action=done===0?{name:'project_service_start',arguments:JSON.stringify({command:"& '"+process.execPath.replaceAll("'","''")+"' './dev-server.cjs'",label:'Fixture frontend'})}
    :done===1?{name:'project_service_status',arguments:'{}'}
    :done===2?{name:'project_preview_ready',arguments:JSON.stringify({url:'http://127.0.0.1:'+fs.readFileSync(path.join(workspace,'port.txt'),'utf8')+'/base/'})}:null;
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const chunk=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
  if(action){chunk({role:'assistant',tool_calls:[{index:0,id:'call-'+done,type:'function',function:action}]});chunk({},'tool_calls');}
  else{chunk({role:'assistant',content:'Project ready'});chunk({},'stop');}res.end('data: [DONE]\n\n');
});
mock.listen(0,'127.0.0.1');await once(mock,'listening');

fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: {
  'startup-fixture': { baseUrl: 'http://127.0.0.1:'+mock.address().port+'/v1', api: 'openai-completions', apiKey: 'offline-fixture', models: [{ id: 'fixture', name: 'Startup fixture', contextWindow: 32000, maxTokens: 2048 }] },
} }));
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'startup-fixture', defaultModel: 'fixture' }));
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, modelKey: 'startup-fixture/fixture', projects: [{ cwd: workspace }] }));
fs.writeFileSync(path.join(workspace, 'readme.txt'), 'Isolated startup verification');
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const system = process.env.SystemRoot || 'C:/Windows';
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', NO_PROXY: '*', HALO_STARTUP_TRACE: '1' };
const args = [...(packaged ? [] : ['.']), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', ws, sequence = 0, exitCode;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-30000); });
child.on('error', error => { output += error.message; });
child.on('exit', code => { exitCode = code; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
async function waitFor(fn, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(60); }
  throw Error(`${message}\n${output}`);
}
try {
  const page = await waitFor(async () => {
    if (exitCode !== undefined) throw Error(`Electron exited ${exitCode}: ${output}`);
    try { return (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) })).json()).find(p => p.type === 'page' && p.url.endsWith('index.html')); } catch { return null; }
  }, 'Main page did not load');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => { const response = JSON.parse(event.data); pending.get(response.id)?.(response); pending.delete(response.id); });
  const send = async (method, params = {}) => {
    const id = ++sequence;
    let timer;
    try { return await Promise.race([new Promise(resolve => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`CDP timeout: ${method}`)), 8000); })]); }
    finally { clearTimeout(timer); pending.delete(id); }
  };
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(response.result?.exceptionDetails, undefined, JSON.stringify(response.result?.exceptionDetails));
    return response.result?.result?.value;
  };

  await waitFor(async () => (await evaluate('window.halo?.startupState().then(r=>r.data)'))?.ready, 'Startup missing');
  await waitFor(()=>evaluate('!!document.querySelector(".project-start")'),'Project start button missing');
  const owner=await evaluate('window.halo.getState().then(r=>r.data)');
  await evaluate('document.querySelector(".project-start").click()');
  await waitFor(()=>evaluate('!!document.querySelector(".project-run-elapsed")'),'Startup progress missing');
  assert.equal(await evaluate('document.querySelector(".project-start").dataset.state'),'busy');
  assert.equal(await evaluate('document.querySelector(".project-start").disabled'),true);
  await waitFor(()=>evaluate('!document.querySelector(".project-run-elapsed")?.textContent.includes("已用 0 秒")'),'Elapsed clock did not advance');
  const progressShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(fixture,'project-starting.png'),Buffer.from(progressShot.result.data,'base64'));
  const getRun=()=>evaluate('window.halo.projectRunList().then(r=>r.data.at(-1))');
  const ready=await waitFor(async()=>{const run=await getRun();if(run?.status==='error')throw Error(JSON.stringify(run));return run?.status==='running'?run:null;},'Background AI failed to start project',60000);
  await waitFor(()=>evaluate('!!document.querySelector("#pvBody webview")'),'Automatic preview missing');
  await waitFor(async()=>await evaluate('document.querySelector("#pvBody webview").getURL()')===ready.urls[0],'Preview did not navigate');
  const guestURL=await evaluate('document.querySelector("#pvBody webview").getURL()');
  assert.equal(guestURL,ready.urls[0]);
  assert.equal(await evaluate('document.querySelector(".project-start").dataset.state'),'running');
  assert.equal(await evaluate('document.querySelector(".project-start").textContent'),'运行中');
  await evaluate('document.querySelector(".project-start").click()');
  assert.equal(await evaluate('window.halo.projectRunList().then(r=>r.data.length)'),1,'Running button must preview, not restart');
  const visible=()=>evaluate('document.querySelector("#pvBody webview").executeJavaScript("document.body.innerText")');
  await waitFor(async()=>String(await visible()).includes('PROJECT_PREVIEW_READY'),'Actual frontend content missing');
  assert.equal((await evaluate('window.halo.getState().then(r=>r.data)')).sessionId,owner.sessionId);
  assert.equal((await evaluate('window.halo.getState().then(r=>r.data)')).messageCount,owner.messageCount,'Launcher must not write to foreground chat');
  await waitFor(()=>calls.length>=4,'AI did not finish');
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal((await fetch(ready.urls[0])).status,200,'Service must outlive its AI');
  await evaluate('window.halo.newSession()');
  assert.notEqual((await evaluate('window.halo.getState().then(r=>r.data)')).sessionId,owner.sessionId,'A running project must not reuse the owner draft');
  assert.equal((await fetch(ready.urls[0])).status,200,'Switching session must not stop the service');
  await evaluate('document.querySelector(".project-run-port").click()');
  await waitFor(async()=>String(await visible()).includes('PROJECT_PREVIEW_READY'),'Port button failed to display frontend');
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(fixture,'project-running.png'),Buffer.from(shot.result.data,'base64'));
  const deleted=await evaluate('window.halo.deleteSession('+JSON.stringify(owner.sessionFile)+')');assert.ok(deleted.ok,JSON.stringify(deleted));
  await waitFor(async()=>{try{await fetch(ready.urls[0],{signal:AbortSignal.timeout(300)});return false;}catch{return true;}},'Deleting owner left service running');
  assert.equal((await getRun()).status,'stopped');
  const launchAgain=async()=>{
    const result=await evaluate('window.halo.projectRunStart()');assert.ok(result.ok,JSON.stringify(result));
    return waitFor(async()=>{const run=await getRun();if(run?.status==='error')throw Error(JSON.stringify(run));return run?.status==='running'?run:null;},'Relaunch failed',60000);
  };
  const waitStopped=url=>waitFor(async()=>{try{await fetch(url,{signal:AbortSignal.timeout(300)});return false;}catch{return true;}},'Owned service was not cleaned up');
  const second=await launchAgain();
  const removed=await evaluate('window.halo.projectRemove('+JSON.stringify(workspace)+')');assert.ok(removed.ok,JSON.stringify(removed));
  await waitStopped(second.urls[0]);
  const added=await evaluate('window.halo.projectAdd('+JSON.stringify(workspace)+')');assert.ok(added.ok,JSON.stringify(added));
  const third=await launchAgain();
  await evaluate('setTimeout(()=>window.halo.close(),30);true');await waitFor(()=>exitCode!==undefined,'App did not close');
  await waitStopped(third.urls[0]);
  console.log(JSON.stringify({ok:true,fixture,calls:calls.length,checks:['independent real SDK agent','managed service','automatic webview','foreground history preserved','survives AI completion and session switch','port button','owner deletion cleanup','project removal cleanup','app close cleanup']}));
} finally {
  if(ws?.readyState===1 && exitCode===undefined){ws.send(JSON.stringify({id:++sequence,method:'Runtime.evaluate',params:{expression:'window.halo.close()'}}));await new Promise(resolve=>setTimeout(resolve,1500));}
  fs.writeFileSync(path.join(fixture, 'process.log'), output);
  mock.closeAllConnections(); mock.close();
  ws?.close();
  if (exitCode === undefined) child.kill();
}
