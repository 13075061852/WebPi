// Real server-preview IPC and webviews through a loopback-only SSH substitute.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-server-preview-'));
const profile = path.join(fixture, 'profile'), agent = path.join(fixture, 'agent'), workspace = path.join(fixture, 'workspace');
for (const dir of [profile, agent, workspace]) fs.mkdirSync(dir);
const ports = { first: 18441, second: 18442, pending: 18443, failure: 18444, loading: 18446 };
const serverRows = ['one', 'two'].map(id => ({ id, name: `Fixture ${id}`, host: '127.0.0.1', username: 'offline', port: 22 }));
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], servers: serverRows, splashed: true, globalProxy: { mode: 'direct', port: 7890 } }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
const controlFile = path.join(fixture, 'control.json'), callsFile = path.join(fixture, 'calls.ndjson');
let control = { releasePending: false, retryEnabled: false, releasePage: false };
const configure = patch => { control = { ...control, ...patch }; fs.writeFileSync(controlFile, JSON.stringify(control)); };
configure({}); fs.writeFileSync(callsFile, '');
const calls = kind => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => !kind || item.kind === kind);
const httpRequests = [], webServers = [], sockets = new Set();
const html = name => `<!doctype html><title>${name}</title><style>body{font:16px system-ui;margin:32px;color:#223;background:#eef2f7}input{padding:12px;width:250px}a{display:block;margin:18px 0}</style><h1>${name}</h1><a href="/dashboard">Continue</a><input id="draft" aria-label="Draft" value=""><script>window.fixtureLoaded=Date.now()</script>`;
const listen = async (name, slow = false) => {
  const server = http.createServer((request, response) => {
    httpRequests.push({ name, method: request.method, url: request.url, at: Date.now() });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (request.method === 'HEAD') { response.end(); return; }
    response.write(html(name));
    if (!slow) { response.end(); return; }
    const timer = setInterval(() => { if (control.releasePage) { clearInterval(timer); response.end(); } }, 20);
    response.once('close', () => clearInterval(timer));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); webServers.push(server);
  return server.address().port;
};
const destination = { first: await listen('First service'), second: await listen('Second service'), loading: await listen('Loading service', true) };
const unavailable = net.createServer(socket => socket.destroy());
unavailable.listen(0, '127.0.0.1'); await once(unavailable, 'listening'); webServers.push(unavailable);
const unavailableURL = `http://127.0.0.1:${unavailable.address().port}/`;
const cdpProbe = net.createServer(); cdpProbe.listen(0, '127.0.0.1'); await once(cdpProbe, 'listening');
const cdpPort = cdpProbe.address().port; await new Promise(resolve => cdpProbe.close(resolve));
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const fs=require('node:fs'),net=require('node:net');
const {EventEmitter}=require('node:events');
const {app,ipcMain,BrowserWindow}=require('electron');
const rows=${JSON.stringify(serverRows)},ports=${JSON.stringify(ports)},destination=${JSON.stringify(destination)};
const read=()=>JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)},'utf8'));
const record=(kind,data={})=>fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({kind,at:Date.now(),...data})+'\\n');
app.on('session-created',created=>created.webRequest.onBeforeRequest((details,done)=>{
  let allowed=true;
  try{const url=new URL(details.url);if(['http:','https:'].includes(url.protocol))allowed=['127.0.0.1','localhost','[::1]'].includes(url.hostname);}catch{}
  done({cancel:!allowed});
}));
app.on('web-contents-created',(_event,contents)=>{
  if(contents.getType()!=='webview')return;
  record('guest-created',{guestId:contents.id});
  contents.on('did-start-loading',()=>record('guest-loading',{guestId:contents.id,url:contents.getURL()}));
  contents.on('dom-ready',()=>{
    record('guest-dom-ready',{guestId:contents.id,url:contents.getURL()});
    contents.executeJavaScript('(()=>{const n=performance.getEntriesByType("navigation")[0];return n?{requestStart:n.requestStart,responseStart:n.responseStart,responseEnd:n.responseEnd,domContentLoaded:n.domContentLoadedEventEnd}:null})()').then(navigation=>record('guest-navigation',{guestId:contents.id,navigation})).catch(()=>{});
  });
  contents.on('did-finish-load',()=>record('guest-loaded',{guestId:contents.id,url:contents.getURL()}));
});
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
  if(channel==='halo:server-list')return {ok:true,data:{items:rows.map(row=>({...row,connected:true})),conversations:[],selected:null}};
  if(channel==='halo:server-ports')return {ok:true,data:{updated:Date.now(),items:Object.values(ports).map(port=>({port,address:'127.0.0.1',protocol:'TCP',process:'offline-http',pid:1}))}};
  if(channel==='halo:server-latencies')return {ok:true,data:rows.map(row=>({id:row.id,status:'ok',ms:1,checkedAt:Date.now()}))};
  if(channel==='halo:server-preview'){
    record('preview-ipc-start',{serverId:args[0],port:args[1]?.port});
    if(args[1]?.port===ports.pending)while(!read().releasePending)await new Promise(resolve=>setTimeout(resolve,20));
    const result=await handler(event,...args);
    record('preview-ipc-end',{serverId:args[0],port:args[1]?.port,ok:result?.ok,url:result?.data,error:result?.error});
    return result;
  }
  return handler(event,...args);
});
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async()=>{throw Error('External fetch disabled by server preview regression');},set:()=>{}});
(async()=>{
  const {ServerManager}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/servers.mjs')).href)});
  ServerManager.prototype.connect=async function(id){
    if(this.clients.has(id))return;
    const client=new EventEmitter();client.end=()=>client.emit('close');
    client.forwardOut=(_source,_sourcePort,_host,port,done)=>{
      const target=port===ports.failure?(read().retryEnabled?destination.second:null):port===ports.second?destination.second:port===ports.loading?destination.loading:destination.first;
      record('ssh-forward',{serverId:id,port,target});
      if(!target){done(Error('Offline service unavailable'));return;}
      const stream=net.connect(target,'127.0.0.1',()=>done(null,stream));
      stream.once('error',error=>{if(!stream.connecting)return;done(error);});
      stream.on('error',()=>{});
    };
    this.clients.set(id,client);
  };
  await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/main.mjs')).href)});
})().catch(error=>{console.error(error);app.exit(1);});
`);

const system = process.env.SystemRoot || 'C:/Windows';
const env = { PATH: process.platform === 'win32' ? [path.dirname(process.execPath), path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter) : process.env.PATH,
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'), TEMP: fixture, TMP: fixture, TMPDIR: fixture,
  PI_CODING_AGENT_DIR: agent, PI_HALO_PI_PATH: path.join(root, 'test/fixtures/pi-sdk.js'), PI_OFFLINE: '1', NO_PROXY: '*',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GH_CONFIG_DIR: path.join(fixture, 'gh'), GCM_INTERACTIVE: 'never', NPM_CONFIG_USERCONFIG: path.join(fixture, 'npmrc') };
if (process.platform === 'win32') Object.assign(env, { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe') });
else for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key];
const child = spawn(electronPath, [bootstrap, `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', exitCode, ws, sequence = 0;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-20000); });
child.on('exit', code => { exitCode = code; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), exceptions = [], passed = [], timings = [];
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check(); if (result) return result;
    if (exitCode !== undefined) throw Error(`Electron exited ${exitCode}: ${output}`);
    await sleep(30);
  }
  throw Error(`Timed out: ${label}\n${JSON.stringify(calls().slice(-20))}\n${output}`);
}
async function command(method, params = {}) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result;
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails)); return response.result?.value;
}
const clickPort = port => evaluate(`[...document.querySelectorAll('#serverPorts .port-row')].find(row=>Number(row.querySelector('b').textContent)===${port}).click()`);
const clickServer = id => evaluate(`document.querySelector('.server-group[data-server-id="${id}"] .server-group-toggle').click()`);
const guest = () => evaluate(`(()=>{const g=document.querySelector('#pvBody webview');try{return g?{id:g.getWebContentsId(),url:g.getURL(),title:g.getTitle()}:null}catch{return null}})()`);
const guestJS = script => evaluate(`document.querySelector('#pvBody webview').executeJavaScript(${JSON.stringify(script)})`);
const previewCalls = port => calls('preview-ipc-start').filter(item => item.port === port);
const pass = label => { passed.push(label); console.log('PASS', label); };
async function loaded(title) {
  return until(async () => { const view = await guest(); return view?.title === title && calls('guest-loaded').some(item => item.guestId === view.id) ? view : null; }, `${title} loaded`);
}
async function openTimed(port, title, label) {
  const start = Date.now(), before = calls('preview-ipc-start').length;
  await clickPort(port); const view = await loaded(title);
  const begin = calls('preview-ipc-start').slice(before).find(item => item.port === port);
  const end = calls('preview-ipc-end').find(item => item.port === port && item.at >= begin.at);
  const created = calls('guest-created').find(item => item.guestId === view.id);
  const ready = calls('guest-dom-ready').find(item => item.guestId === view.id);
  const finished = calls('guest-loaded').find(item => item.guestId === view.id);
  timings.push({ label, port, guestId: view.id, clickToIPC: begin.at - start, prepareService: end.at - begin.at, mountGuest: created.at - end.at, guestDOM: ready.at - created.at, guestLoaded: finished.at - created.at, total: finished.at - start });
  return view;
}

try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(item => item.type === 'page' && item.url.endsWith('index.html')); } catch {} }, 'main renderer');
  ws = new WebSocket(target.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), item = pending.get(response.id);
    if (item) { clearTimeout(item.timer); pending.delete(response.id); item.resolve(response); }
    if (response.method === 'Runtime.exceptionThrown') exceptions.push(response.params.exceptionDetails);
  });
  await command('Runtime.enable'); await command('Page.enable'); await command('Page.bringToFront');
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until(() => evaluate('!!window.__haloDispatch && window.halo.startupState().then(r=>r.data.ready)'), 'isolated startup');
  await until(() => evaluate('!!document.querySelector(".server-group[data-server-id=one]")'), 'virtual servers');
  await evaluate('document.querySelector(".nav-item[data-tab=skills]").click()'); await clickServer('one');
  await until(() => evaluate(`document.querySelector('#sideFilesTitle').textContent.includes('Fixture one') && document.querySelectorAll('#serverPorts .port-row').length===${Object.keys(ports).length}`), 'first server ports');

  const first = await openTimed(ports.first, 'First service', 'first opening'); pass('Actual server-preview IPC and authenticated webview loading');
  await guestJS('document.querySelector("a").click()');
  await until(async () => (await guest())?.url.endsWith('/dashboard'), 'guest navigation');
  await loaded('First service'); await guestJS('document.querySelector("#draft").value="keep my form"');
  const requestCount = httpRequests.length, ipcCount = previewCalls(ports.first).length;
  await clickPort(ports.first); await evaluate('window.halo.serverList()');
  assert.equal((await guest()).id, first.id); assert.equal(previewCalls(ports.first).length, ipcCount); assert.equal(httpRequests.length, requestCount);
  assert.equal(await guestJS('document.querySelector("#draft").value'), 'keep my form'); assert.ok((await guest()).url.endsWith('/dashboard'));
  pass('Same loaded port preserves guest, navigation, form, HTTP requests and IPC count');
  await evaluate('document.querySelector("#btnPreviewToggle").click()');
  await until(() => evaluate('document.body.classList.contains("preview-collapsed") && !document.documentElement.classList.contains("layout-motion")'), 'collapsed preview');
  await clickPort(ports.first);
  await until(() => evaluate('!document.body.classList.contains("preview-collapsed") && !document.documentElement.classList.contains("layout-motion")'), 'same port revealed');
  assert.equal((await guest()).id, first.id); assert.equal(await guestJS('document.querySelector("#draft").value'), 'keep my form');
  pass('Collapsed port reopens the existing browser');

  await clickServer('two'); await until(() => evaluate('document.querySelector("#sideFilesTitle").textContent.includes("Fixture two")'), 'browse second server with live guest');
  await clickServer('one'); await until(() => evaluate('document.querySelector("#sideFilesTitle").textContent.includes("Fixture one")'), 'return to live guest server');
  await clickPort(ports.first); assert.equal((await guest()).id, first.id);
  await evaluate(`document.querySelector('#pvBody webview').loadURL(${JSON.stringify(unavailableURL)}).catch(()=>{})`);
  await until(() => evaluate('document.querySelector("#pvBody .pv-empty")?.textContent.includes("网页加载失败")'), 'reused guest reports navigation failure');
  assert.equal(await guest(), null);
  await clickPort(ports.first); const recovered = await loaded('First service');
  assert.notEqual(recovered.id, first.id); assert.equal(previewCalls(ports.first).length, ipcCount + 1);
  pass('Guest reused after server browsing still reports navigation failure and can retry');

  await clickPort(ports.pending); await clickPort(ports.pending); await evaluate('window.halo.serverList()');
  assert.equal(previewCalls(ports.pending).length, 1); assert.equal(await guest(), null);
  configure({ releasePending: true }); const pendingGuest = await loaded('First service');
  assert.notEqual(pendingGuest.id, first.id); pass('Double click during tunnel preparation starts one IPC');

  await clickPort(ports.loading);
  const loadingGuest = await until(async () => { const view = await guest(); return view && calls('guest-loading').some(item => item.guestId === view.id) ? view : null; }, 'loading guest attached');
  assert.equal(calls('guest-loaded').some(item => item.guestId === loadingGuest.id), false, 'Loading reuse is exercised before document completion');
  const loadingIPC = previewCalls(ports.loading).length;
  await clickPort(ports.loading); await evaluate('window.halo.serverList()');
  assert.equal((await guest()).id, loadingGuest.id); assert.equal(previewCalls(ports.loading).length, loadingIPC);
  configure({ releasePage: true }); await loaded('Loading service'); pass('Repeated click while the document is loading preserves the guest');

  const second = await openTimed(ports.second, 'Second service', 'different port');
  assert.notEqual(second.id, loadingGuest.id); pass('Different port creates the intended browser');
  await clickPort(ports.failure);
  await until(() => evaluate('document.querySelector("#pvBody .pv-empty")?.textContent.includes("该端口") || document.querySelector("#pvBody .pv-empty")?.textContent.includes("不可访问")'), 'service failure');
  assert.equal(await guest(), null);
  configure({ retryEnabled: true }); await clickPort(ports.failure); await loaded('Second service');
  assert.equal(previewCalls(ports.failure).length, 2); pass('Unavailable service remains retryable');

  configure({ releasePending: false }); const pendingBefore = previewCalls(ports.pending).length;
  await clickPort(ports.pending); await until(() => previewCalls(ports.pending).length === pendingBefore + 1, 'stale opening starts');
  await clickPort(ports.second); const latest = await loaded('Second service');
  configure({ releasePending: true });
  await until(() => calls('preview-ipc-end').filter(item => item.port === ports.pending).length === pendingBefore + 1, 'stale opening finished');
  await evaluate('window.halo.serverList()'); assert.equal((await guest()).id, latest.id); pass('Old opening completion cannot replace a newer port');

  configure({ releasePending: false }); const switchBefore = previewCalls(ports.pending).length;
  await clickPort(ports.pending); await until(() => previewCalls(ports.pending).length === switchBefore + 1, 'switch race opening');
  await clickServer('two'); await until(() => evaluate('document.querySelector("#sideFilesTitle").textContent.includes("Fixture two")'), 'second server selected');
  await clickServer('one'); await until(() => evaluate(`document.querySelector('#sideFilesTitle').textContent.includes('Fixture one') && document.querySelectorAll('#serverPorts .port-row').length===${Object.keys(ports).length}`), 'first server selected again');
  await clickPort(ports.pending); await evaluate('window.halo.serverList()');
  assert.equal(previewCalls(ports.pending).length, switchBefore + 2, 'Returning must replace an invalidated pending request');
  configure({ releasePending: true }); await loaded('First service');
  assert.equal((await guest()).title, 'First service'); pass('Server switch invalidates pending reuse and returning can open again');
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  fs.mkdirSync('test/results/server-preview', { recursive: true });
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('test/results/server-preview/preview.png', Buffer.from(screenshot.data, 'base64'));
  fs.writeFileSync('test/results/server-preview/report.json', JSON.stringify({ fixture, passed, timings, httpRequests, stages: calls() }, null, 2));
  console.log(`PASS server preview: ${passed.length} checks; timings ${JSON.stringify(timings)}`);
} finally {
  configure({ releasePending: true, releasePage: true });
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear(); ws?.close(); child.kill();
  for (const socket of sockets) socket.destroy();
  for (const server of webServers) server.close();
}
