// Real preview entries, project switching and background refresh in an isolated
// Electron profile. The only website is a loopback HTTP fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-preview-visibility-'));
const profile = path.join(fixture, 'profile'), agent = path.join(fixture, 'agent');
const workspace = path.join(fixture, 'project-one'), otherProject = path.join(fixture, 'project-two');
for (const dir of [profile, agent, workspace, otherProject]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }, { cwd: otherProject }], splashed: true }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
fs.writeFileSync(path.join(workspace, 'preview.md'), '# Preview first version');
fs.writeFileSync(path.join(workspace, 'slow.md'), '# Stale preview must not return');
fs.writeFileSync(path.join(workspace, 'artifact.html'), '<!doctype html><title>Artifact fixture</title><h1>Artifact fixture</h1>');
fs.writeFileSync(path.join(otherProject, 'second.md'), '# Second project');
const controlFile = path.join(fixture, 'control.json'), callsFile = path.join(fixture, 'calls.ndjson');
let control = { events: [], releaseRead: false, releaseCreate: false };
const configure = patch => { control = { ...control, ...patch }; fs.writeFileSync(controlFile, JSON.stringify(control)); };
configure({}); fs.writeFileSync(callsFile, '');
const calls = channel => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => !channel || item.channel === channel);
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const fs=require('node:fs');
const {ipcMain,BrowserWindow}=require('electron');
const register=ipcMain.handle.bind(ipcMain);
const read=()=>JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)},'utf8'));
const record=(channel,args)=>fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({channel,args})+'\\n');
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
  if(['halo:read-file','halo:project-switch','halo:create-entry'].includes(channel))record(channel,args);
  if(channel==='halo:read-file'&&String(args[0]).endsWith('slow.md')){
    const result=await handler(event,...args);
    while(!read().releaseRead)await new Promise(resolve=>setTimeout(resolve,20));
    record('fixture:slow-read-released',args);return result;
  }
  if(channel==='halo:create-entry'&&args[0]?.name==='created-late.md'){
    const result=await handler(event,...args);
    while(!read().releaseCreate)await new Promise(resolve=>setTimeout(resolve,20));
    record('fixture:create-released',args);return result;
  }
  return handler(event,...args);
});
let sent=0;
setInterval(()=>{
  const events=read().events;
  for(;sent<events.length;sent++)for(const window of BrowserWindow.getAllWindows())window.webContents.send('pi:event',events[sent]);
},25).unref();
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async()=>{throw Error('External network disabled by preview regression');},set:()=>{}});
import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/main.mjs')).href)}).catch(error=>{console.error(error);process.exitCode=1;});
`);
const website = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Local website fixture</title><h1>Local website fixture</h1>');
});
website.listen(0, '127.0.0.1'); await once(website, 'listening');
const websiteURL = `http://127.0.0.1:${website.address().port}/`;
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const system = process.env.SystemRoot || 'C:/Windows';
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: agent, PI_HALO_PI_PATH: path.join(root, 'test/fixtures/pi-sdk.js'), PI_OFFLINE: '1', NO_PROXY: '*' };
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', exitCode, ws, sequence = 0;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-20000); });
child.on('exit', code => { exitCode = code; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), exceptions = [], passed = [];
async function until(check, label, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check(); if (result) return result;
    if (exitCode !== undefined) throw Error(`Electron exited ${exitCode}: ${output}`);
    await sleep(40);
  }
  throw Error(`Timed out: ${label}\n${output}`);
}
async function command(method, params = {}) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
  return response.result?.value;
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const state = () => evaluate('window.halo.getState().then(r=>r.data)');
const matchPath = (a, b) => a?.replaceAll('\\', '/').toLowerCase() === b?.replaceAll('\\', '/').toLowerCase();
async function assertVisibility(collapsed, label) {
  await until(() => evaluate(`!!document.body && !document.documentElement.classList.contains('layout-motion') && document.body.classList.contains('preview-collapsed') === ${collapsed}`), label);
  const view = await evaluate(`(()=>{const center=document.querySelector('#center'),toggle=document.querySelector('#btnPreviewToggle');return {width:center.getBoundingClientRect().width,inert:center.inert,expanded:toggle.getAttribute('aria-expanded'),name:document.querySelector('#pvName').textContent}})()`);
  assert.equal(view.inert, collapsed, `${label}: hidden preview must be inert`);
  assert.equal(view.expanded, String(!collapsed), `${label}: preview toggle matches visibility`);
  assert.ok(collapsed ? view.width < 1 : view.width > 100, `${label}: actual preview width ${view.width}`);
  passed.push(label); console.log('PASS', label);
}
async function treeFile(name) {
  await until(() => evaluate(`[...document.querySelectorAll('#wsTree .fname')].some(item=>item.textContent===${JSON.stringify(name)})`), `file tree contains ${name}`);
  await evaluate(`[...document.querySelectorAll('#wsTree .fname')].find(item=>item.textContent===${JSON.stringify(name)}).closest('.trow').click()`);
}
async function switchProject(cwd) {
  await evaluate(`[...document.querySelectorAll('#projList .project-toggle')].find(item=>item.title===${JSON.stringify(cwd)}).closest('.project-group').querySelector('.project-new').click()`);
  await until(async () => matchPath((await state()).cwd, cwd), 'project switched');
  await until(async () => matchPath(await evaluate('document.documentElement.dataset.projectCwd'), cwd), 'renderer project state');
}
async function assistantMessage(text) {
  await evaluate(`(()=>{const d=window.__haloDispatch,text=${JSON.stringify(text)};d({type:'agent_start'});d({type:'message_start',message:{role:'assistant',content:[]}});d({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});d({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'endTurn'}});d({type:'agent_end',messages:[],willRetry:false});d({type:'agent_settled'});})()`);
}

try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && item.url.endsWith('index.html')); } catch {} }, 'main renderer');
  ws = new WebSocket(target.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), item = pending.get(response.id);
    if (item) { clearTimeout(item.timer); pending.delete(response.id); item.resolve(response); }
    if (response.method === 'Runtime.exceptionThrown') exceptions.push(response.params.exceptionDetails);
  });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Page.bringToFront');
  await command('Emulation.setDeviceMetricsOverride', { width: 1120, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until(() => evaluate('!!window.__haloDispatch && window.halo.startupState().then(r=>r.data.ready)'), 'startup');
  assert.deepEqual((await evaluate('window.halo.githubStatus()'))?.data?.accounts, [], 'No personal accounts in regression');
  await assertVisibility(true, 'Cold startup keeps preview collapsed');

  await treeFile('preview.md');
  await until(() => evaluate('document.querySelector("#pvBody").textContent.includes("Preview first version")'), 'Markdown preview');
  await assertVisibility(false, 'File tree opens preview');
  await click('#btnPreviewToggle'); await assertVisibility(true, 'Manual collapse');
  await treeFile('preview.md'); await assertVisibility(false, 'Opening same file reopens collapsed preview');
  await click('#btnNewFile');
  await evaluate(`(()=>{const input=document.querySelector('#wsTree .create-input');input.value='created-late.md';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await until(() => calls('halo:create-entry').some(call => call.args[0]?.name === 'created-late.md'), 'delayed create-entry started');
  await click('#btnPreviewToggle'); await assertVisibility(true, 'Manual collapse during pending file creation');
  configure({ releaseCreate: true });
  await until(() => calls('fixture:create-released').length === 1, 'delayed create-entry released');
  await until(() => evaluate(`!document.querySelector('#wsTree .create-input') && [...document.querySelectorAll('#wsTree .fname')].some(item=>item.textContent==='created-late.md')`), 'created file listed after callback');
  await assertVisibility(true, 'Late file creation cannot reopen manually collapsed preview');
  assert.equal(await evaluate('document.querySelector("#pvName").textContent'), 'preview.md', 'Delayed file creation must not replace the selected preview');
  assert.match(await evaluate('document.querySelector("#pvBody").textContent'), /Preview first version/);
  fs.writeFileSync(path.join(workspace, 'preview.md'), '# Background updated version');
  const current = await state(), reads = calls('halo:read-file').length;
  configure({ events: [...control.events, { event: { type: 'agent_settled' }, sessionId: current.sessionId, serverId: null, cwd: current.cwd }] });
  await until(() => calls('halo:read-file').length > reads, 'settled event refresh reaches real read IPC');
  await until(() => evaluate('document.querySelector("#pvBody").textContent.includes("Background updated version")'), 'background preview content updated');
  await assertVisibility(true, 'Agent settled refresh never reopens a collapsed preview');

  await evaluate(`(()=>{const d=window.__haloDispatch;d({type:'agent_start'});d({type:'tool_execution_start',toolCallId:'preview-background-write',toolName:'write',args:{path:'artifact.html'}});d({type:'tool_execution_end',toolCallId:'preview-background-write',isError:false,result:{content:[{type:'text',text:'File written'}]}});d({type:'agent_end',messages:[],willRetry:false});d({type:'agent_settled'});})()`);
  await assertVisibility(true, 'Background HTML write does not open preview');
  assert.equal(await evaluate('document.querySelector("#pvName").textContent'), 'preview.md', 'Background generated file cannot replace the selected preview');

  await assistantMessage('[Open artifact](artifact.html)');
  await until(() => evaluate('!!document.querySelector(".artifact-card")'), 'artifact card');
  await assertVisibility(true, 'Rendering artifact card alone leaves preview collapsed');
  await click('.artifact-card'); await assertVisibility(false, 'Artifact card opens preview');
  await until(() => evaluate('!!document.querySelector("#pvBody iframe")'), 'HTML artifact mounted');
  await switchProject(otherProject);
  await assertVisibility(true, 'Switching project closes an open preview');
  assert.equal(await evaluate('document.querySelector("#pvName").textContent'), '未选择文件');
  assert.equal(await evaluate('document.querySelectorAll("#pvBody iframe,#pvBody webview").length'), 0);

  await switchProject(workspace); await assertVisibility(true, 'Returning to project starts collapsed');
  await treeFile('slow.md');
  await until(() => calls('halo:read-file').some(call => String(call.args[0]).endsWith('slow.md')), 'delayed preview request began');
  await switchProject(otherProject); await assertVisibility(true, 'Project switch closes pending preview');
  configure({ releaseRead: true });
  await until(() => calls('fixture:slow-read-released').length === 1, 'old preview request released');
  await sleep(100);
  await assertVisibility(true, 'Late preview response cannot reopen previous project');
  assert.doesNotMatch(await evaluate('document.querySelector("#pvBody").textContent'), /Stale preview/);
  assert.equal(await evaluate('document.querySelector("#pvName").textContent'), '未选择文件');

  await assistantMessage(`[Local fixture](${websiteURL})`);
  await until(() => evaluate(`[...document.querySelectorAll('.md a')].some(link=>link.href===${JSON.stringify(websiteURL)})`), 'website link');
  await evaluate(`[...document.querySelectorAll('.md a')].find(link=>link.href===${JSON.stringify(websiteURL)}).click()`);
  await assertVisibility(false, 'Website link opens preview');
  await until(() => evaluate('document.querySelector("#pvBody webview")?.getTitle()==="Local website fixture"'), 'loopback website loaded');
  await click('#btnPreviewToggle'); await assertVisibility(true, 'Website preview can be collapsed');
  await evaluate(`[...document.querySelectorAll('.md a')].find(link=>link.href===${JSON.stringify(websiteURL)}).click()`);
  await assertVisibility(false, 'Opening same website reopens preview');

  // Reload starts a fresh renderer even if the previous preview was expanded.
  await evaluate('window.__previousPreviewDocument = true');
  await command('Page.reload');
  await until(() => evaluate('!window.__previousPreviewDocument && !!window.__haloDispatch && window.halo.startupState().then(r=>r.data.ready)'), 'reload startup');
  await assertVisibility(true, 'Reload does not restore an empty expanded preview');
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  fs.mkdirSync('test/results/preview-visibility', { recursive: true });
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test/results/preview-visibility/default-collapsed.png', Buffer.from(screenshot.data, 'base64'));
  fs.writeFileSync('test/results/preview-visibility/report.json', JSON.stringify({ fixture, passed }, null, 2));
  console.log(`PASS preview visibility: ${passed.length} checks; ${fixture}`);
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear(); ws?.close(); child.kill(); website.closeAllConnections(); website.close();
}
