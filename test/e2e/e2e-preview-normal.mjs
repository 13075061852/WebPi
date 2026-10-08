// Ordinary preview coverage in an isolated Electron profile, using local files
// and a loopback website. No personal accounts or external inference are used.
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
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-preview-normal-'));
const profile = path.join(fixture, 'profile'), agent = path.join(fixture, 'agent'), workspace = path.join(fixture, 'workspace');
for (const dir of [profile, agent, workspace]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
const gitConfig = path.join(fixture, 'empty-gitconfig'); fs.writeFileSync(gitConfig, '');
const guestSnapshot = `({id:window.fixtureId,draft:document.querySelector('#draft')?.value,touch:!!window.__haloTouchOn,touchStyle:!!document.getElementById('__halo-touch'),homeStyle:!!document.getElementById('__halo-home'),scrollbar:getComputedStyle(document.documentElement).scrollbarWidth,cursor:getComputedStyle(document.body).cursor,pointerTypes:window.pointerTypes})`;
const html = `<!doctype html><meta charset="utf-8"><title>Normal preview fixture</title>
<style>html{overflow-y:scroll}body{margin:0;padding:24px;background:#eef4ff;font:16px sans-serif;min-height:2400px}input{width:180px}h1{font-size:24px}button{display:block;margin-top:20px;width:160px;height:44px}</style>
<h1>Normal preview fixture</h1><input id="draft" value="original"><button id="mouse">Mouse target</button>
<script>window.fixtureId=Math.random().toString(36);window.pointerTypes=[];document.addEventListener('pointerdown',e=>window.pointerTypes.push(e.pointerType));
addEventListener('message',event=>{if(event.data?.type!=='normal-fixture-probe')return;if(typeof event.data.draft==='string')document.querySelector('#draft').value=event.data.draft;parent.postMessage({type:'normal-fixture-state',state:${guestSnapshot}},'*')});</script>`;
fs.writeFileSync(path.join(workspace, 'artifact.html'), html);
fs.writeFileSync(path.join(workspace, 'second.html'), html);
fs.writeFileSync(path.join(workspace, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#608dd9"/><circle cx="160" cy="120" r="60" fill="#d5e9ff"/></svg>');
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async()=>{throw Error('External network disabled by preview regression');},set:()=>{}});
import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/main.mjs')).href)}).catch(error=>{console.error(error);process.exitCode=1;});
`);
let websiteLoads = 0;
const website = http.createServer((request, response) => {
  if (request.url === '/') websiteLoads++;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html);
});
website.listen(0, '127.0.0.1'); await once(website, 'listening');
const websiteURL = `http://127.0.0.1:${website.address().port}/`;
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
const pending = new Map(), exceptions = [], passed = [], measurements = [];
const resultDir = path.join(root, 'test/results/preview-normal'); fs.mkdirSync(resultDir, { recursive: true });
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
  assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result;
}
async function evaluate(expression, contextId) {
  const response = await command('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true, userGesture: true });
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails)); return response.result?.value;
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const pass = label => { passed.push(label); console.log('PASS', label); };
const settled = () => until(() => evaluate('!document.documentElement.classList.contains("layout-motion") && !document.querySelector(".device-switch-mask,.device-morph-overlay,.device-morph-hidden")'), 'layout settled');
async function mode(device) {
  await click(`.pvdev[data-dev="${device}"]`); await settled();
  assert.equal(await evaluate(`document.querySelector('#pvBody').classList.contains('dev-${device}') && document.querySelector('.pvdev.active').dataset.dev === '${device}'`), true);
}
async function treeFile(name) {
  await until(() => evaluate(`[...document.querySelectorAll('#wsTree .fname')].some(item=>item.textContent===${JSON.stringify(name)})`), `file tree contains ${name}`);
  await evaluate(`[...document.querySelectorAll('#wsTree .fname')].find(item=>item.textContent===${JSON.stringify(name)}).closest('.trow').click()`);
  await settled();
}
async function guestState(kind, draft) {
  if (kind === 'webview') return evaluate(`document.querySelector('#pvBody webview').executeJavaScript(${JSON.stringify(`${draft === undefined ? '' : `document.querySelector('#draft').value=${JSON.stringify(draft)};`}${guestSnapshot}`)})`);
  return evaluate(`new Promise(resolve=>{const frame=document.querySelector('#pvBody iframe');if(!frame){resolve(null);return;}const listener=e=>{if(e.source===frame.contentWindow&&e.data?.type==='normal-fixture-state'){clearTimeout(timer);removeEventListener('message',listener);resolve(e.data.state)}};const timer=setTimeout(()=>{removeEventListener('message',listener);resolve(null)},700);addEventListener('message',listener);frame.contentWindow.postMessage(${JSON.stringify({ type: 'normal-fixture-probe', draft })},'*')})`);
}
async function assertTouch(kind, enabled) {
  await until(async () => (await guestState(kind))?.touch === enabled, `${kind} touch ${enabled}`);
  const state = await guestState(kind);
  assert.equal(state.touchStyle, enabled); assert.equal(state.homeStyle, enabled);
  if (!enabled) { assert.notEqual(state.scrollbar, 'none'); assert.doesNotMatch(state.cursor, /crosshair|data:image/); }
}
async function assertNormal(selector, toolbarHeight = 0) {
  const value = await evaluate(`(()=>{const body=document.querySelector('#pvBody'),guest=body.querySelector(${JSON.stringify(selector)});const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};const style=n=>{const s=getComputedStyle(n);return {border:parseFloat(s.borderTopWidth),radius:parseFloat(s.borderRadius),shadow:s.boxShadow,clip:s.clipPath}};const pseudo=n=>['::before','::after'].map(p=>{const s=getComputedStyle(n,p);return s.display==='none'||['none','normal'].includes(s.content)});return {body:rect(body),guest:rect(guest),styles:[...body.querySelectorAll('.dev-shell,.dev-screen')].map(style),pseudo:[body,...body.querySelectorAll('.dev-shell')].flatMap(pseudo),statusbar:[...body.querySelectorAll('.dev-statusbar')].every(n=>getComputedStyle(n).display==='none'),toolbar:body.querySelector('.website-toolbar')?.getBoundingClientRect().height||0}})()`);
  for (const style of value.styles) { assert.equal(style.border, 0); assert.equal(style.radius, 0); assert.equal(style.shadow, 'none'); assert.equal(style.clip, 'none'); }
  assert.ok(value.pseudo.every(Boolean), 'Normal mode must remove device pseudo elements');
  assert.ok(value.statusbar, 'Normal mode must hide device status bar');
  assert.equal(value.toolbar, toolbarHeight);
  for (const [actual, expected, label] of [[value.guest.x, value.body.x, 'x'], [value.guest.y, value.body.y + toolbarHeight, 'y'], [value.guest.width, value.body.width, 'width'], [value.guest.height, value.body.height - toolbarHeight, 'height']]) assert.ok(Math.abs(actual - expected) < 2, `${selector} fills available ${label}: ${actual} vs ${expected}`);
  measurements.push({ selector, ...value });
}
async function assertFooter() {
  const footer = await evaluate(`(()=>{const f=document.querySelector('.pv-devices'),rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {center:document.querySelector('#center').getBoundingClientRect().width,footer:rect(f),items:[...f.querySelectorAll('.pvdev,#pvDevSize')].filter(n=>getComputedStyle(n).display!=='none').map(n=>({name:n.textContent.trim(),...rect(n)}))}})()`);
  for (const item of footer.items) { assert.ok(item.width > 0 && item.height > 0); assert.ok(item.left >= footer.footer.left && item.right <= footer.footer.right + 1, `${item.name} fits footer`); }
  for (let i = 0; i < footer.items.length; i++) for (let j = i + 1; j < footer.items.length; j++) {
    const a = footer.items[i], b = footer.items[j];
    assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, `${a.name} overlaps ${b.name}`);
  }
  measurements.push({ footer }); return footer.center;
}
async function screenshot(name) {
  const shot = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(resultDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && item.url.endsWith('index.html')); } catch {} }, 'main renderer');
  ws = new WebSocket(target.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), item = pending.get(response.id);
    if (item) { clearTimeout(item.timer); pending.delete(response.id); item.resolve(response); }
    if (response.method === 'Runtime.exceptionThrown') exceptions.push(response.params.exceptionDetails);
  });
  await command('Runtime.enable'); await command('Page.enable'); await command('Page.bringToFront');
  await command('Emulation.setDeviceMetricsOverride', { width: 1120, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until(() => evaluate('!!window.__haloDispatch && window.halo.startupState().then(r=>r.data.ready)'), 'startup');
  assert.deepEqual((await evaluate('window.halo.githubStatus()'))?.data?.accounts, [], 'No personal accounts');
  assert.equal(await evaluate('document.querySelector(".pvdev.active").dataset.dev'), 'desktop');
  await click('#btnPreviewToggle'); await settled(); await mode('normal');
  const empty = await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.pv-gscreen'));return {border:parseFloat(s.borderTopWidth),radius:parseFloat(s.borderRadius),shadow:s.boxShadow,stands:[...document.querySelectorAll('.pv-gneck,.pv-gbase')].map(n=>getComputedStyle(n).display)}})()`);
  assert.equal(empty.border, 0); assert.equal(empty.radius, 0); assert.equal(empty.shadow, 'none'); assert.ok(empty.stands.every(display => display === 'none'));
  await assertFooter();
  await command('Emulation.setDeviceMetricsOverride', { width: 1042, height: 900, deviceScaleFactor: 1, mobile: false });
  const centerWidth = await assertFooter(); assert.ok(centerWidth <= 320 && centerWidth >= 300, `Narrow preview fixture expected around 314px, got ${centerWidth}`);
  await screenshot('normal-empty'); pass('Desktop remains default; normal empty state and 314px footer have no device outline or overlap');

  await treeFile('artifact.html');
  await until(async () => (await guestState('iframe'))?.id, 'HTML fixture ready');
  await guestState('iframe', 'retained input');
  const initialHTML = await guestState('iframe');
  await assertTouch('iframe', false); await assertNormal('iframe');
  for (const device of ['desktop', 'tablet', 'mobile']) {
    await mode(device); await assertTouch('iframe', device !== 'desktop');
    await mode('normal'); await assertTouch('iframe', false); await assertNormal('iframe');
    const current = await guestState('iframe'); assert.equal(current.id, initialHTML.id); assert.equal(current.draft, 'retained input');
  }
  const point = await evaluate(`(()=>{const r=document.querySelector('#pvBody iframe').getBoundingClientRect();return {x:r.x+45,y:r.y+145}})()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await until(async () => (await guestState('iframe')).pointerTypes.includes('mouse'), 'normal guest receives mouse input');
  await screenshot('normal-html'); pass('HTML fills normal mode; all device round trips preserve page/input and restore mouse/scrollbars');
  await mode('mobile');
  await evaluate(`document.querySelector('.pvdev[data-dev="normal"]').click();[...document.querySelectorAll('#wsTree .fname')].find(item=>item.textContent==='second.html').closest('.trow').click()`);
  await settled(); await until(async () => (await guestState('iframe'))?.id, 'new HTML during mode change');
  await assertTouch('iframe', false); await assertNormal('iframe'); pass('Opening a new HTML preview during mobile-to-normal switching finishes with touch disabled');

  await evaluate(`(()=>{const d=window.__haloDispatch,text=${JSON.stringify(`[Local fixture](${websiteURL})`)};d({type:'agent_start'});d({type:'message_start',message:{role:'assistant',content:[]}});d({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});d({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'endTurn'}});d({type:'agent_end',messages:[],willRetry:false});d({type:'agent_settled'});})()`);
  await until(() => evaluate(`[...document.querySelectorAll('.md a')].some(link=>link.href===${JSON.stringify(websiteURL)})`), 'website link');
  await evaluate(`[...document.querySelectorAll('.md a')].find(link=>link.href===${JSON.stringify(websiteURL)}).click()`); await settled();
  await until(() => evaluate(`document.querySelector('#pvBody webview')?.getTitle()==='Normal preview fixture'`), 'webview ready');
  await guestState('webview', 'retained website input');
  const initialWeb = await guestState('webview'), initialLoads = websiteLoads;
  await assertTouch('webview', false); await assertNormal('webview', 38);
  for (const device of ['desktop', 'tablet', 'mobile']) {
    await mode(device); await assertTouch('webview', device !== 'desktop');
    await mode('normal'); await assertTouch('webview', false); await assertNormal('webview', 38);
    const current = await guestState('webview'); assert.equal(current.id, initialWeb.id); assert.equal(current.draft, 'retained website input');
  }
  assert.equal(websiteLoads, initialLoads, 'Mode switches must not issue new website loads');
  await assertFooter(); pass('Loopback webview fills normal mode below 38px toolbar without guest reload on any device round trip');
  await evaluate(`document.documentElement.dataset.theme='light';document.documentElement.dataset.surface='glass'`);
  await until(() => evaluate('document.querySelector(".pv-devices").classList.contains("glass-surface")'), 'glass theme applied');
  await assertNormal('webview', 38); await assertFooter(); await screenshot('normal-website-glass'); pass('Glass theme keeps normal geometry and footer legible');

  await treeFile('image.svg'); await until(() => evaluate('document.querySelector("#pvBody img")?.naturalWidth===320'), 'image loaded');
  await assertNormal('.pv-img'); await screenshot('normal-image'); pass('Image preview has no shell, stand, or rounded screen');
  // Generate a real small playable video offline instead of relying on a corrupt placeholder.
  const video = await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=160;c.height=90;const x=c.getContext('2d');const stream=c.captureStream(10),r=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];r.ondataavailable=e=>chunks.push(e.data);const done=new Promise(resolve=>r.onstop=resolve);r.start();let frame=0;const timer=setInterval(()=>{x.fillStyle='#608dd9';x.fillRect(0,0,160,90);x.fillStyle='#d5e9ff';x.fillRect(frame++*6,20,30,30);},50);await new Promise(resolve=>setTimeout(resolve,600));clearInterval(timer);r.stop();await done;stream.getTracks().forEach(t=>t.stop());return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}))})})()`);
  fs.writeFileSync(path.join(workspace, 'video.webm'), Buffer.from(video, 'base64')); await click('#treeRefresh');
  await treeFile('video.webm'); await until(() => evaluate('document.querySelector("#pvBody video")?.videoWidth===160'), 'video metadata');
  await assertNormal('.pv-video'); await screenshot('normal-video'); pass('Playable video preview has no device decoration');
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  fs.writeFileSync(path.join(resultDir, 'report.json'), JSON.stringify({ fixture, passed, websiteLoads, measurements }, null, 2));
  console.log(`PASS ordinary preview: ${passed.length} checks; ${resultDir}`);
  await evaluate('setTimeout(()=>window.halo.close(),30);true'); await until(() => exitCode !== undefined, 'Electron shutdown');
} finally {
  fs.writeFileSync(path.join(resultDir, 'process.log'), output);
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear(); ws?.close(); if (exitCode === undefined) child.kill(); website.closeAllConnections(); website.close();
}
