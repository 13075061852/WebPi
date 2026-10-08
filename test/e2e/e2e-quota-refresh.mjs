// Real renderer/IPC/session handlers in an isolated profile. Quotas and remote
// server replies are local fixtures; no personal account or provider is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-quota-refresh-'));
const profile = path.join(fixture, 'profile'), agent = path.join(fixture, 'agent'), workspace = path.join(fixture, 'workspace');
for (const directory of [profile, agent, workspace]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
const controlFile = path.join(fixture, 'control.json'), callsFile = path.join(fixture, 'calls.ndjson');
let control = { quota: { kind: 'points', label: '积分', value: 81 } };
const configure = patch => { control = { ...control, ...patch }; fs.writeFileSync(controlFile, JSON.stringify(control)); };
configure({});
fs.writeFileSync(callsFile, '');
const calls = channel => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => !channel || item.channel === channel);
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const fs = require('node:fs');
const { ipcMain } = require('electron');
const handlers = new Map(), register = ipcMain.handle.bind(ipcMain);
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)}, 'utf8'));
const record = (channel,args) => fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({channel,args})+'\\n');
ipcMain.handle = (channel,handler) => {
  handlers.set(channel,handler);
  register(channel,async(event,...args) => {
    const control = read();
    if (['halo:model-quota','halo:new-session','halo:server-new-session','halo:usage-summary'].includes(channel)) record(channel,args);
    if (channel === 'halo:model-quota') return {ok:true,data:control.quota};
    if (channel === 'halo:new-session' && control.localFailure) return {ok:false,error:'Fixture local create failed'};
    if (channel === 'halo:server-new-session') {
      if (control.serverFailure) return {ok:false,error:'Fixture server create failed'};
      // Exercise the server entry's UI continuation with a real isolated session,
      // while keeping SSH/network out of this renderer regression.
      return handlers.get('halo:new-session')(event);
    }
    if (channel === 'halo:server-list') return {ok:true,data:{items:[{id:'fixture-server',name:'Offline server',username:'fixture',host:'fixture.invalid',connected:true}],conversations:[],selected:null}};
    if (channel === 'halo:server-latencies') return {ok:true,data:[]};
    if (channel === 'halo:server-ports') return {ok:true,data:{items:[],updated:Date.now()}};
    if (channel === 'halo:auth-providers') return {ok:true,data:[{id:'fixture',name:'Fixture account',configured:true,currentId:'fixture-account',accounts:[{id:'fixture-account',label:'Offline account',quota:control.quota}]}]};
    if (channel === 'halo:auth-account-quotas') return {ok:true,data:[{id:'fixture-account',quota:control.quota}]};
    return handler(event,...args);
  });
};
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async()=>{throw Error('Network disabled by quota regression');},set:()=>{}});
import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/main.mjs')).href)}).catch(error=>{console.error(error);process.exitCode=1;});
`);
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const system = process.env.SystemRoot || 'C:/Windows';
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: agent, PI_HALO_PI_PATH: path.join(root, 'test/fixtures/pi-sdk.js'), PI_OFFLINE: '1', NO_PROXY: '*' };
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', exitCode, ws, sequence = 0;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-30000); });
child.on('exit', code => { exitCode = code; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, message, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn(); if (value) return value;
    if (exitCode !== undefined) throw Error(`Electron exited ${exitCode}: ${output}`);
    await sleep(50);
  }
  throw Error(`${message}\n${output}`);
}
const pending = new Map();
async function command(method, params = {}) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method} ${params.expression?.slice(0, 120) || ''}`)); }, 10000);
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
const quotaText = () => evaluate('document.querySelector("#ctxQuotaText")?.textContent');
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const state = () => evaluate('window.halo.getState().then(r=>r.data)');
const tickMinute = () => evaluate('for(const tick of window.__minuteTimers.values()) tick(); true');
async function assertRefresh(trigger, expected) {
  const before = calls('halo:model-quota').length;
  await trigger();
  await waitFor(() => calls('halo:model-quota').length > before, 'Expected quota refresh');
  await waitFor(async () => (await quotaText()) === expected, `Expected quota text: ${expected}`);
  assert.ok(calls('halo:model-quota').slice(before).every(call => call.args[0] === 'fixture' && call.args[1] === true), 'All refreshes must skip the quota cache');
}

try {
  const page = await waitFor(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(page => page.type === 'page' && page.url.endsWith('index.html')); } catch {} }, 'Main page did not load');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => { const response = JSON.parse(event.data), item = pending.get(response.id); if (item) { clearTimeout(item.timer); pending.delete(response.id); item.resolve(response); } });
  await command('Page.enable');
  await waitFor(() => evaluate('window.halo?.startupState().then(r=>r.data.ready)'), 'Initial startup did not complete');
  // Capture only 60-second timers. All animation/startup timers retain real time.
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__minuteTimers=new Map();let id=-1;
    const schedule=window.setInterval,clear=window.clearInterval;
    window.setInterval=(callback,delay,...args)=>{if(delay===60000){const key=id--;window.__minuteTimers.set(key,()=>callback(...args));return key;}return schedule(callback,delay,...args);};
    window.clearInterval=key=>{if(!window.__minuteTimers.delete(key))clear(key);};
  ` });
  await command('Page.reload');
  await waitFor(() => evaluate('!!window.__haloDispatch && !!window.__minuteTimers && document.querySelector("#ctxQuotaText")?.textContent === "积分 81"'), 'Renderer/initial quota did not become ready').catch(async error => { throw Error(error.message + '\n' + JSON.stringify(await evaluate('({hook:!!window.__haloDispatch,timers:window.__minuteTimers?.size,quota:document.querySelector("#ctxQuotaText")?.textContent})'))); });
  await waitFor(async () => (await state())?.ready, 'Isolated session did not become ready');
  await sleep(200); // settle initial duplicate startup state notifications

  configure({ quota: { kind: 'points', label: '积分', value: 82 } });
  await assertRefresh(tickMinute, '积分 82');
  configure({ quota: { kind: 'points', label: '积分', value: 83 } });
  await assertRefresh(tickMinute, '积分 83');

  const localCreates = calls('halo:new-session').length;
  configure({ quota: { kind: 'points', label: '积分', value: 84 } });
  await assertRefresh(() => click('#btnNewSession'), '积分 84');
  assert.equal(calls('halo:new-session').length, localCreates + 1, 'Local creation must call the real session handler');
  assert.ok((await state()).sessionId, 'The existing empty draft may be reused, but must still refresh quota');
  configure({ localFailure: true });
  let before = calls('halo:model-quota').length;
  await click('#btnNewSession');
  await waitFor(() => evaluate('document.body.textContent.includes("Fixture local create failed")'), 'Local creation failure was not shown');
  await sleep(100);
  assert.equal(calls('halo:model-quota').length, before, 'Failed local creation must not refresh quota');
  configure({ localFailure: false });

  await click('#sideNav [data-tab="skills"]');
  await waitFor(() => evaluate('!!document.querySelector("#serverList .server-group-new")'), 'Offline server entry missing');
  const serverCreates = calls('halo:server-new-session').length;
  configure({ quota: { kind: 'points', label: '积分', value: 85 } });
  await assertRefresh(() => click('#serverList .server-group-new'), '积分 85');
  assert.equal(calls('halo:server-new-session').length, serverCreates + 1, 'Server entry must call its new-session handler');
  configure({ serverFailure: true });
  before = calls('halo:model-quota').length;
  await click('#serverList .server-group-new');
  await waitFor(() => evaluate('document.body.textContent.includes("Fixture server create failed")'), 'Server creation failure was not shown');
  await sleep(100);
  assert.equal(calls('halo:model-quota').length, before, 'Failed server creation must not refresh quota');
  configure({ serverFailure: false });

  configure({ quota: { error: true, authExpired: true } });
  await assertRefresh(tickMinute, '账户过期');
  await click('#authBtn');
  await waitFor(() => evaluate('document.querySelector(".acc-quota")?.textContent === "账户过期"'), 'Saved account should show account-expired status too');
  await click('#authModal [data-close]');
  configure({ quota: { kind: 'points', label: '积分', value: 86 } });
  await assertRefresh(tickMinute, '积分 86');
  configure({ quota: { error: true } });
  await assertRefresh(tickMinute, '额度 —');
  assert.doesNotMatch(await quotaText(), /账户过期/);

  configure({ quota: { kind: 'points', label: '积分', value: 87 } });
  await assertRefresh(() => evaluate('window.__haloDispatch({type:"tool_execution_end",toolCallId:"quota-fixture-tool",toolName:"read",result:{content:[]}})'), '积分 87');
  configure({ quota: { kind: 'points', label: '积分', value: 88 } });
  await assertRefresh(() => evaluate('window.__haloDispatch({type:"agent_settled"})'), '积分 88');

  await click('#ctxQuota');
  await waitFor(() => evaluate('document.querySelector("#usageDetailBody")?.textContent.includes("今日用量")'), 'Quota click must still open usage details');
  const usageBefore = calls('halo:usage-summary').length;
  await click('#refreshUsageDetail');
  await waitFor(() => calls('halo:usage-summary').length > usageBefore, 'Existing manual usage refresh must remain available');

  const minuteCount = await evaluate('window.__minuteTimers.size');
  await evaluate('dispatchEvent(new Event("pagehide"))');
  assert.equal(await evaluate('window.__minuteTimers.size'), minuteCount - 1, 'Quota polling must be cleared on page exit');
  console.log(JSON.stringify({ ok: true, fixture, checks: ['two one-minute forced refreshes', 'real local new session success/failure', 'server new-session UI success/failure with fake server IPC', 'expired footer and saved-account status', 'quota recovery and network-error distinction', 'tool and settled refreshes', 'manual usage refresh', 'timer cleanup'], quotaRequests: calls('halo:model-quota').length }));
} finally {
  if (ws?.readyState === 1 && exitCode === undefined) {
    ws.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate', params: { expression: 'window.halo.close()' } }));
    await Promise.race([once(child, 'exit'), sleep(1500)]);
  }
  fs.writeFileSync(path.join(fixture, 'process.log'), output);
  ws?.close(); if (exitCode === undefined) child.kill();
}
