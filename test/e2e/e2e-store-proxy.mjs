// Real renderer/preload IPC with fake Store/system-proxy handlers. This regression
// never invokes CheckNetIsolation, requests elevation, or changes Windows settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const root = process.cwd(), fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-store-proxy-ui-'));
const profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace'), agent = path.join(fixture, 'agent');
for (const dir of [profile, workspace, agent]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
const gitConfig = path.join(fixture, 'empty-gitconfig'); fs.writeFileSync(gitConfig, '');
const input = path.join(fixture, 'store-fixture.json'), callsFile = path.join(fixture, 'store-calls.jsonl');
const available = { supported: true, installed: true, enabled: false };
const writeState = values => fs.writeFileSync(input, JSON.stringify({ status: { ok: true, data: available }, ...values }));
const calls = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
writeState({});
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const {ipcMain}=require('electron'),fs=require('node:fs');
const handle=ipcMain.handle.bind(ipcMain),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
ipcMain.handle=(channel,handler)=>handle(channel,
  /^halo:proxy-store-(status|repair)$/.test(channel)?async()=>{
    const state=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));
    const action=channel.endsWith('repair')?'repair':'status';
    fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({action,time:Date.now()})+'\\n');
    await pause(state[action+'Delay']||0);
    return state[action]||{ok:false,error:'No repair result configured by fixture'};
  }:
  channel==='halo:proxy-get'?async()=>({ok:true,data:{mode:'direct',port:7890,system:{flags:1,server:''}}}):
  channel==='halo:proxy-set'?async()=>{throw Error('System proxy mutation blocked by regression')}:
  channel==='halo:environment-status'?async()=>({ok:true,data:{platform:'win32',revision:1,tools:[],progress:[],installing:false,installer:{available:false}}}):
  channel==='halo:github-status'?async()=>({ok:true,data:{accounts:[]}}):
  channel==='halo:cloudflare-status'?async()=>({ok:true,data:{authorized:false,accounts:[]}}):
  /^halo:(environment-(install|repair)|github-|cloudflare-)/.test(channel)?async()=>{throw Error('Mutation blocked by Store regression')}:handler);
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async()=>{throw Error('External network disabled by Store regression')},set:()=>{}});
import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/main.mjs')).href)}).catch(error=>{console.error(error);process.exitCode=1});
`);
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const system = process.env.SystemRoot || 'C:/Windows';
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: agent, PI_HALO_PI_PATH: path.join(root, 'test/fixtures/pi-sdk.js'), PI_OFFLINE: '1', NO_PROXY: '*',
  GCM_CREDENTIAL_STORE: 'plaintext', GCM_PLAINTEXT_STORE_PATH: path.join(fixture, 'empty-gcm-store'),
  GH_CONFIG_DIR: path.join(fixture, 'gh'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig };
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', exitCode, ws, sequence = 0;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-20000); });
child.on('exit', code => { exitCode = code; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), exceptions = [], passed = [];
const resultDir = path.join(root, 'test/results/store-proxy'); fs.mkdirSync(resultDir, { recursive: true });
async function until(check, label, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    if (exitCode !== undefined) throw Error(`Electron exited ${exitCode}: ${output}`);
    await sleep(50);
  }
  throw Error(`Timed out: ${label}\n${output}`);
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
async function click(selector) {
  const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function reopen() { await click('.set-nav[data-pane="environment"]'); await click('.set-nav[data-pane="proxy"]'); }
const ui = () => evaluate(`(()=>{const b=document.querySelector('#proxyStoreRepair'),s=document.querySelector('#proxyStoreStatus');return {status:s.textContent,button:b.textContent,disabled:b.disabled,busy:b.getAttribute('aria-busy'),message:document.querySelector('#proxyStoreResult').textContent}})()`);
const pass = label => { passed.push(label); console.log('PASS', label); };
async function screenshot(name) {
  const shot = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(resultDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
}
try {
  let target;
  await until(async () => { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && item.url.endsWith('index.html')); return target; } catch {} }, 'main renderer');
  ws = new WebSocket(target.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), item = pending.get(response.id);
    if (item) { clearTimeout(item.timer); pending.delete(response.id); item.resolve(response); }
    if (response.method === 'Runtime.exceptionThrown') exceptions.push(response.params.exceptionDetails);
  });
  await command('Runtime.enable'); await command('Page.enable'); await command('Page.bringToFront');
  await command('Emulation.setDeviceMetricsOverride', { width: 1120, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(() => evaluate('!!window.__haloDispatch && window.halo.startupState().then(r=>r.data.ready)'), 'startup');
  assert.deepEqual((await evaluate('window.halo.githubStatus()')).data.accounts, []);
  assert.equal((await evaluate('window.halo.cloudflareStatus()')).data.authorized, false);
  await click('#btnSettings'); await click('.set-nav[data-pane="proxy"]');
  await until(async () => (await ui()).status === '未配置', 'initial Store status');
  assert.equal((await ui()).disabled, false);
  assert.equal(calls().filter(call => call.action === 'repair').length, 0);
  pass('Opening proxy settings reads Store status through real preload; no implicit repair');

  for (const theme of ['light', 'dark', 'glass']) {
    await click('.set-nav[data-pane="appearance"]'); await click(`[data-theme-choice="${theme}"]`); await click('.set-nav[data-pane="proxy"]');
    await until(async () => (await ui()).status === '未配置', `${theme} status`);
    await sleep(250);
    assert.ok(await evaluate(`(()=>{const p=document.querySelector('#setPane-proxy .set-body'),b=document.querySelector('#proxyStoreRepair'),r=b.getBoundingClientRect();return p.scrollWidth-p.clientWidth<2&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b})()`));
    if (theme === 'glass') assert.equal(await evaluate(`document.querySelector('.proxy-store-card').classList.contains('glass-surface')`), true);
    await screenshot(theme);
  }
  pass('Microsoft Store card fits light, dark and glass; action remains clickable');

  writeState({ repairDelay: 650, repair: { ok: false, error: '已取消系统授权，可重新点击配置。' } });
  await click('#proxyStoreRepair'); await click('#proxyStoreRepair'); await click('#proxyStoreRepair');
  assert.equal((await ui()).busy, 'true'); assert.equal((await ui()).disabled, true);
  assert.equal(calls().filter(call => call.action === 'repair').length, 1);
  await reopen(); assert.equal((await ui()).busy, 'true');
  await until(async () => (await ui()).busy === null, 'authorization cancellation');
  assert.match((await ui()).message, /取消/); assert.equal((await ui()).disabled, false);
  pass('Repeated real clicks submit once; pending authorization survives navigation and cancel allows retry');

  writeState({ repair: { ok: false, error: '配置失败：系统策略阻止此操作。' } });
  await click('#proxyStoreRepair');
  await until(async () => (await ui()).message.includes('系统策略'), 'failed repair');
  assert.equal((await ui()).disabled, false); assert.equal((await ui()).busy, null);
  writeState({ repair: { ok: true, data: { ...available, enabled: true } } });
  await click('#proxyStoreRepair');
  await until(async () => (await ui()).status === '已配置', 'retry success');
  assert.equal((await ui()).disabled, true); assert.equal((await ui()).button, '已配置');
  assert.match((await ui()).message, /重新打开 Microsoft Store/);
  await click('#proxyStoreRepair'); assert.equal(calls().filter(call => call.action === 'repair').length, 3);
  await screenshot('configured');
  pass('Errors are actionable; retry succeeds, clears busy state and prevents redundant configuration');

  writeState({}); await reopen();
  await until(async () => (await ui()).status === '未配置', 'external exemption removal');
  assert.equal((await ui()).message, ''); assert.equal((await ui()).disabled, false);
  writeState({ statusDelay: 700 });
  const reads = calls().filter(call => call.action === 'status').length;
  await reopen(); await until(() => calls().filter(call => call.action === 'status').length > reads, 'first delayed read');
  writeState({ status: { ok: true, data: { ...available, enabled: true } } }); await reopen();
  await until(async () => (await ui()).status === '已配置', 'newer read'); await sleep(800);
  assert.equal((await ui()).status, '已配置'); assert.equal((await ui()).disabled, true);
  pass('Reopening reflects external changes; stale status response cannot undo newer status');

  for (const [state, expected] of [[{ supported: false, installed: false, enabled: false }, '仅支持 Windows'], [{ ...available, installed: false }, '未安装商店']]) {
    writeState({ status: { ok: true, data: state } }); await reopen();
    await until(async () => (await ui()).status === expected, expected); assert.equal((await ui()).disabled, true);
    await click('#proxyStoreRepair'); assert.equal(calls().filter(call => call.action === 'repair').length, 3);
  }
  writeState({ status: { ok: false, error: '无法读取商店配置，请重试。' } }); await reopen();
  await until(async () => (await ui()).status === '检测失败', 'read failure');
  assert.equal((await ui()).disabled, false); assert.match((await ui()).message, /无法读取/);
  writeState({}); await reopen(); await until(async () => (await ui()).status === '未配置', 'read recovery');
  assert.equal((await ui()).message, '');
  pass('Missing Store and unsupported OS disable repair; status errors are visible and recover on reopen');
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  fs.writeFileSync(path.join(resultDir, 'report.json'), JSON.stringify({ passed, calls: calls(), isolatedAccounts: true, systemMutation: false }, null, 2));
  console.log(`PASS Store proxy: ${passed.length} checks; ${resultDir}`);
  await evaluate('setTimeout(()=>window.halo.close(),30);true'); await until(() => exitCode !== undefined, 'Electron shutdown');
} finally {
  fs.writeFileSync(path.join(resultDir, 'process.log'), output);
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear(); ws?.close(); if (exitCode === undefined) child.kill();
}
