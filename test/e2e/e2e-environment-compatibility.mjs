// Renderer compatibility scenarios in a separate Electron profile. Installer and
// authorization APIs are stubbed; this test never installs or authorizes anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const root = process.cwd(), fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-environment-compatibility-'));
const profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace'), agent = path.join(fixture, 'agent');
for (const dir of [profile, workspace, agent]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
const gitConfig = path.join(fixture, 'empty-gitconfig'); fs.writeFileSync(gitConfig, '');
const state = { platform: 'win32', arch: 'arm64', osRelease: '10.0.26100', revision: 100, installing: false, progress: [],
  installer: { name: 'WinGet', available: false, automaticAvailable: true, version: '1.10.390', path: 'C:/Users/Fixture/AppData/Local/Microsoft/WindowsApps/winget.exe', error: '未找到 WinGet', helpUrl: 'https://learn.microsoft.com/windows/package-manager/winget/' },
  tools: [
    { id: 'python', name: 'Python', installed: false, version: '3.13.7', path: 'C:/Users/Fixture/Python/python.exe', problem: 'path', repairPaths: ['C:/Users/Fixture/Python'], error: 'Python 已安装，但 PATH 尚未配置。' },
    { id: 'node', name: 'Node.js', installed: true, version: '24.0.0', path: 'C:/Program Files/nodejs/node.exe' },
    { id: 'git', name: 'Git', installed: false, problem: 'missing' },
  ] };
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const {ipcMain}=require('electron');
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>handle(channel,channel==='halo:environment-status'?async()=>({ok:true,data:${JSON.stringify(state)}}):
  channel==='halo:github-status'?async()=>({ok:true,data:{accounts:[]}}):
  channel==='halo:cloudflare-status'?async()=>({ok:true,data:{authorized:false,accounts:[]}}):
  /^halo:(environment-(install|repair)|github-|cloudflare-)/.test(channel)?async()=>{throw Error('Mutation blocked by environment regression')}:handler);
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async()=>{throw Error('External network disabled by environment regression')},set:()=>{}});
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
const resultDir = path.join(root, 'test/results/environment-compatibility'); fs.mkdirSync(resultDir, { recursive: true });
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
  await click('#btnSettings'); await click('.set-nav[data-pane="environment"]');
  await until(() => evaluate('document.querySelector("#setPane-environment").getAttribute("aria-busy")==="false"'), 'initial environment snapshot');
  const ipcSnapshot = await evaluate('window.halo.environmentStatus()');
  assert.equal(ipcSnapshot.data.installer.available, false);
  assert.equal(ipcSnapshot.data.installer.automaticAvailable, true);
  assert.equal(await evaluate('document.querySelector("#environmentInstall").disabled'), false);
  assert.equal(await evaluate('document.querySelector("[data-tool=python] .environment-status").textContent'), '待配置 PATH');
  pass('Main-process fixture reaches real preload IPC and enables fallback installation without WinGet');
  await evaluate(`(async()=>{
    const old=document.querySelector('#setPane-environment'),pane=old.cloneNode(true);pane.querySelector('#environmentTools').replaceChildren();old.replaceWith(pane);
    const f=window.envFixture={state:${JSON.stringify(state)},calls:0,clipboard:''};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{f.clipboard=text}}});
    const api={environmentStatus:async()=>({ok:true,data:structuredClone(f.state)}),environmentInstall:()=>{f.calls++;return new Promise(resolve=>{f.resolve=resolve})},onEnvironmentProgress:fn=>{f.emit=fn},openExternal:async url=>{f.help=url;return{ok:true}},githubStatus:async()=>({ok:true,data:{accounts:[]}}),cloudflareStatus:async()=>({ok:true,data:{authorized:false,accounts:[]}})};
    const {initEnvironmentSettings}=await import('./js/environment-settings.mjs');f.controller=initEnvironmentSettings({api});await f.controller.refresh();
  })()`);
  assert.equal(await evaluate('document.querySelector("#environmentInstall").disabled'), false);
  assert.equal(await evaluate('document.querySelector("#environmentIssue").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#environmentCopyDiagnostics").hidden'), true);
  assert.equal(await evaluate('document.querySelector("[data-tool=python] .environment-status").textContent'), '待配置 PATH');
  assert.match(await evaluate('document.querySelector("[data-tool=python] .environment-tool-version").textContent'), /3\.13\.7/);
  assert.match(await evaluate('document.querySelector("[data-tool=python] .environment-tool-detail").textContent'), /PATH/);
  assert.equal(await evaluate('document.querySelector("[data-tool=git] .environment-status").textContent'), '未安装');
  await screenshot('fallback-path'); pass('Official fallback enabled without WinGet; PATH repair is distinct from missing installation');
  await click('#environmentInstall'); await click('#environmentInstall');
  assert.equal(await evaluate('envFixture.calls'), 1);
  assert.equal(await evaluate('document.querySelector("#environmentRefresh").disabled'), true);
  await evaluate(`envFixture.state.revision=102;envFixture.state.installing=true;envFixture.state.progress=[{id:'python',state:'installing',message:'正在配置 PATH'}];envFixture.emit(structuredClone(envFixture.state));envFixture.resolve({ok:true,data:{...structuredClone(envFixture.state),revision:101,installing:false,progress:[]}})`);
  await until(() => evaluate('document.querySelector("[data-tool=python]").dataset.state==="busy"'), 'live progress wins stale response');
  assert.equal(await evaluate('document.querySelector("#environmentInstall").textContent'), '正在配置…');
  pass('Real repeated clicks invoke one install; late IPC does not replace newer progress');
  await evaluate(`envFixture.state.revision=103;envFixture.state.installing=false;envFixture.state.progress.push({id:'git',state:'failed',message:'Git 下载失败，请检查网络后重试。',details:'Download failed: network timeout\\nProxy: http://proxy-user:proxy-password@127.0.0.1:7890\\n'+'safe installer diagnostic line\\n'.repeat(60),output:{nested:['socks5://socks-user:socks-password@127.0.0.1:1080','Proxy-Authorization: Basic dXNlcjpzZWNyZXQ='],token:'test-token-secret'}});envFixture.emit(structuredClone(envFixture.state))`);
  assert.equal(await evaluate('document.querySelector("#environmentCopyDiagnostics").hidden'), false);
  assert.equal(await evaluate('document.querySelector("#environmentProgress details").open'), false);
  assert.ok(await evaluate('document.querySelector("[data-tool=git] .environment-tool-detail").textContent.length<100'));
  for (const theme of ['light', 'dark', 'glass']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme === 'dark' ? 'dark' : 'light')};${theme === 'glass' ? "document.documentElement.dataset.surface='glass'" : 'delete document.documentElement.dataset.surface'}`);
    await sleep(200);
    await click('#environmentProgress summary');
    assert.equal(await evaluate('document.querySelector("#environmentProgress details").open'), true);
    assert.ok(await evaluate('document.querySelector("#environmentProgress pre").textContent.length>1000'));
    assert.ok(await evaluate('document.querySelector(".environment-body").scrollWidth-document.querySelector(".environment-body").clientWidth<2'));
    await click('#environmentProgress summary');
    await screenshot(`failure-${theme}`);
  }
  pass('Failure summaries stay concise; detailed logs expand/collapse and fit all three themes');
  await click('#environmentCopyDiagnostics');
  const report = JSON.parse(await evaluate('envFixture.clipboard'));
  assert.equal(report.platform, 'win32'); assert.equal(report.arch, 'arm64'); assert.equal(report.osRelease, '10.0.26100');
  assert.equal(report.installer.automaticAvailable, true); assert.equal(report.tools.length, 3);
  assert.equal(report.installer.version, state.installer.version); assert.equal(report.installer.path, state.installer.path);
  assert.match(report.progress.at(-1).details, /network timeout/);
  assert.deepEqual(Object.keys(report).sort(), ['arch', 'installer', 'osRelease', 'platform', 'progress', 'tools']);
  assert.doesNotMatch(JSON.stringify(report), /github|cloudflare|auth\.json|proxy-user|proxy-password|socks-user|socks-password|dXNlcjpzZWNyZXQ=|test-token-secret/i);
  assert.equal(report.progress.at(-1).output.token, '[redacted]');
  pass('Copy diagnostics contains environment state and full failure log, without account information');
  await evaluate(`envFixture.state.revision=104;envFixture.state.installer={...envFixture.state.installer,available:true,automaticAvailable:false};envFixture.emit(structuredClone(envFixture.state))`);
  assert.equal(await evaluate('document.querySelector("#environmentInstall").disabled'), true);
  await click('#environmentHelp'); assert.match(await evaluate('envFixture.help'), /^https:\/\/learn\.microsoft\.com\//);
  await evaluate(`envFixture.state.revision=105;envFixture.state.tools.forEach(tool=>{tool.installed=true;tool.problem=null;tool.version='1.2.3';tool.error=null});envFixture.emit(structuredClone(envFixture.state))`);
  assert.equal(await evaluate('document.querySelector("#environmentInstall").textContent'), '环境已就绪');
  assert.equal(await evaluate('document.querySelector("#environmentIssue").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#environmentCopyDiagnostics").hidden'), true);
  assert.equal(await evaluate('document.querySelectorAll(".environment-tool[data-state=ready]").length'), 3);
  pass('Explicit installer unavailability disables action; recovered tools clear failed-run controls despite old logs');
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  fs.writeFileSync(path.join(resultDir, 'report.json'), JSON.stringify({ passed, diagnostics: report }, null, 2));
  console.log(`PASS environment compatibility: ${passed.length} checks; ${resultDir}`);
  await evaluate('setTimeout(()=>window.halo.close(),30);true'); await until(() => exitCode !== undefined, 'Electron shutdown');
} finally {
  fs.writeFileSync(path.join(resultDir, 'process.log'), output);
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear(); ws?.close(); if (exitCode === undefined) child.kill();
}
