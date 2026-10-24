// Isolated Electron website navigation regression; uses only local HTTP fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const executableArgument = process.env.HALO_PACKAGED_EXE;
const executable = path.resolve(executableArgument || 'node_modules/electron/dist/electron.exe');
const packaged = Boolean(executableArgument);
const base = path.join(os.tmpdir(), 'halo-website-navigation-e2e');
fs.mkdirSync(base, { recursive: true });
const fixture = fs.mkdtempSync(path.join(base, 'run-'));
const agent = path.join(fixture, 'agent'), profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace');
for (const dir of [agent, profile, workspace]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: {
  'startup-fixture': { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'offline-fixture', models: [{ id: 'fixture', name: 'Startup fixture', contextWindow: 32000, maxTokens: 2048 }] },
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
const requests=[];
const server=http.createServer((req,res)=>{
  requests.push(req.url);
  if(req.url==='/redirect') {res.writeHead(302,{Location:'/destination?from=redirect'});res.end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(req.url==='/'?`<title>Navigation fixture</title>
    <a id="same" href="/destination?from=same">普通链接</a>
    <a id="blank" href="/destination?from=blank" target="_blank"><span>新窗口链接</span></a>
    <button id="script" onclick="window.open('/destination?from=script','_blank')">脚本打开</button>
    <a id="redirect" href="/redirect" target="_blank">重定向链接</a>
    <form action="/destination" method="get" target="_blank"><input name="from" value="form"><button id="submit">搜索</button></form>
    <button id="blocked" onclick="window.open('file:///C:/Windows/win.ini','_blank')">禁止非网页协议</button>`:
    '<title>Destination</title><h1>导航成功</h1>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
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
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(r=>r.data)'))?.ready, 'Startup did not finish');
  await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', {enabled:true});
  await waitFor(() => evaluate('!document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches'), 'Animated test page must be visible with motion enabled');
  await send('Runtime.enable');
  const errors = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Page.enable');
  assert.match(page.url, /index.html$/);
  assert.ok(await evaluate('document.title && document.querySelector("#wsTree") && document.querySelector("#chat")'));


  await evaluate('document.querySelector("#btnPreviewToggle").click()');
  await waitFor(()=>evaluate('!document.documentElement.classList.contains("layout-motion")'),'Settle layout');
  const initialPages=(await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(p=>p.type==='page').length;
  await evaluate(`document.querySelector('#btnBrowser').click();document.querySelector('#previewAddress').value=${JSON.stringify(origin)};document.querySelector('#previewAddressForm').requestSubmit()`);
  const guestURL = () => evaluate("(()=>{try{return document.querySelector('webview')?.getURL()}catch{return ''}})()");
  const guestReady = async url => {
    await waitFor(async()=>await guestURL()===url,`Guest did not navigate to ${url}`);
    await waitFor(()=>evaluate("!document.querySelector('webview').isLoading() && document.querySelector('webview').executeJavaScript('document.readyState===\"complete\"')"),'Guest document not ready');
  };
  const home = async () => {
    await evaluate(`document.querySelector('webview').loadURL(${JSON.stringify(origin)})`);
    await guestReady(origin+'/');
  };
  await guestReady(origin+'/');
  assert.equal(await evaluate("document.querySelector('[data-nav=back]').disabled"),true,'First page has no back history');
  for(const [id,query] of [['same','same'],['blank','blank'],['script','script'],['redirect','redirect'],['submit','form']]) {
    if(id!=='same') await home();
    await evaluate(`document.querySelector('webview').executeJavaScript(${JSON.stringify(`document.querySelector('#${id}').click()`)},true)`);
    const destination=origin+'/destination?from='+query;
    await guestReady(destination);
    await waitFor(()=>evaluate(`document.querySelector('.website-toolbar input').value===${JSON.stringify(destination)} && document.querySelector('#pvName').textContent==='Destination'`),'Address and session callback did not synchronize');
    assert.equal(await evaluate("document.querySelector('webview').executeJavaScript('document.querySelector(\"h1\").textContent')"),'导航成功');
    await waitFor(()=>evaluate("!document.querySelector('[data-nav=back]').disabled"),'Back button did not enable');
    await evaluate("document.querySelector('[data-nav=back]').click()");
    await guestReady(origin+'/');
    await waitFor(()=>evaluate(`document.querySelector('.website-toolbar input').value===${JSON.stringify(origin+'/')}`),'Back did not update address');
    if(id==='same') assert.equal(await evaluate("document.querySelector('[data-nav=back]').disabled"),true,'Back at first page becomes disabled');
  }
  await home();
  await evaluate(`document.querySelector('webview').executeJavaScript("history.pushState(null,'','#details')",true)`);
  await guestReady(origin+'/#details');
  await waitFor(()=>evaluate("!document.querySelector('[data-nav=back]').disabled"),'SPA back missing');
  await evaluate("document.querySelector('[data-nav=back]').click()");await guestReady(origin+'/');
  await evaluate(`document.querySelector('webview').executeJavaScript("document.querySelector('#blocked').click()",true)`);
  await sleep(350);
  assert.equal(await guestURL(),origin+'/', 'Non-web popup remains blocked');
  const pages=(await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(p=>p.type==='page').length;
  assert.equal(pages,initialPages,'Links must not create extra app windows');
  assert.deepEqual(errors,[],'No renderer exceptions');
  assert.ok(requests.includes('/destination?from=blank') && requests.includes('/destination?from=form'));
  await evaluate(`document.querySelector('webview').loadURL(${JSON.stringify(origin+'/destination?from=blank')})`);
  await guestReady(origin+'/destination?from=blank');
  await sleep(200);
  const shot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(fixture,'website-navigation.png'),Buffer.from(shot.result.data,'base64'));
  await evaluate("document.querySelector('[data-zoom=in]').click()");
  assert.equal(await evaluate("document.querySelector('[data-zoom=reset]').textContent"),'110%');
  await evaluate("document.querySelector('[data-zoom=reset]').click()");
  assert.equal(await evaluate("document.querySelector('[data-zoom=reset]').textContent"),'100%');
  await evaluate('document.querySelector("[data-theme-choice=light]").click();window.resizeTo(1160,800)');
  await sleep(450);
  await waitFor(()=>evaluate('!document.documentElement.classList.contains("layout-motion")'),'Compact motion incomplete');
  const toolbar=await evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,center:r.y+r.height/2,height:r.height};};return {row:rect('.website-toolbar'),groups:['[data-nav=back]','.website-address','.website-zoom','[data-nav=external]'].map(rect),input:document.querySelector('.website-toolbar input').getBoundingClientRect().width};})()`);
  assert.ok(toolbar.input>80,JSON.stringify(toolbar));
  for(let i=0;i<toolbar.groups.length;i++) {
    assert.equal(toolbar.groups[i].height,28);
    assert.ok(Math.abs(toolbar.groups[i].center-toolbar.groups[0].center)<1,JSON.stringify(toolbar));
    assert.ok(toolbar.groups[i].left>=toolbar.row.left && toolbar.groups[i].right<=toolbar.row.right,JSON.stringify(toolbar));
    if(i) assert.ok(toolbar.groups[i].left-toolbar.groups[i-1].right>=7,JSON.stringify(toolbar));
  }
  const compactShot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(fixture,'website-toolbar-light-compact.png'),Buffer.from(compactShot.result.data,'base64'));
  // Real webviews use a separate compositor surface. Device changes must keep
  // the surrounding text live and retain this same guest through the handoff.
  await evaluate(`window.__websiteGuestId=document.querySelector('webview').getWebContentsId();
    document.startViewTransition=()=>{throw Error('Device change captured the document')};
    document.querySelector('#layout').startViewTransition=()=>{throw Error('Device change captured the workspace')};`);
  for (const mode of ['normal','tablet','mobile','desktop','mobile','mobile']) {
    await evaluate(`document.querySelector('.pvdev[data-dev="${mode}"]').click()`);
    await waitFor(()=>evaluate('document.documentElement.classList.contains("layout-motion-live")'),'Live device animation did not start');
    const frames=await evaluate(`(()=>{
      const animations=document.getAnimations().filter(a=>a.effect?.target?.closest('.device-morph-overlay')||(a.id==='device-pane-motion')||a.effect?.target?.id==='layout');
      animations.forEach(a=>a.pause());window.__deviceAnimations=animations;
      return [0,80,140,280].map(time=>{animations.forEach(a=>a.currentTime=time);return [...document.querySelectorAll('#sidebar,#chat')].map(node=>{
        const style=getComputedStyle(node),rect=node.getBoundingClientRect();
        return {visible:style.visibility==='visible'&&+style.opacity===1,unscaled:(()=>{const m=new DOMMatrix(style.transform);return m.a===1&&m.d===1&&m.b===0&&m.c===0})(),width:rect.width,height:rect.height};
      });});
    })()`);
    for (const frame of frames) for (const pane of frame) assert.ok(pane.visible&&pane.unscaled&&pane.width>100&&pane.height>100,JSON.stringify(frame));
    if (mode==='mobile') {
      await evaluate('__deviceAnimations.forEach(a=>a.currentTime=140)');
      const midpoint=await send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(fixture,'website-device-midpoint.png'),Buffer.from(midpoint.result.data,'base64'));
    }
    await evaluate('__deviceAnimations.forEach(a=>a.play())');
    await waitFor(()=>evaluate('!document.documentElement.classList.contains("layout-motion")&&!document.querySelector(".device-morph-overlay,.device-switch-mask")'),'Device handoff left an overlay');
    assert.equal(await evaluate('document.querySelector("webview").getWebContentsId()===window.__websiteGuestId'),true,'Switching cannot recreate the webpage');
    assert.equal(await guestURL(),origin+'/destination?from=blank');
  }
  assert.deepEqual(errors,[],'No renderer exceptions after toolbar interactions');
  console.log(JSON.stringify({ok:true,fixture,checks:['compact toolbar alignment','light/dark screenshots','zoom controls','initial back disabled','back navigation/address sync','first page disabled again','SPA history back','normal link','target=_blank','window.open','redirect','target blank GET form','address/session sync','non-web denied','no extra windows','no renderer exceptions']}));
  await evaluate('setTimeout(()=>window.halo.close(),30);true');await waitFor(()=>exitCode!==undefined,'App did not close');
} finally {
  server.closeAllConnections();server.close();
  fs.writeFileSync(path.join(fixture, 'process.log'), output);
  ws?.close();
  if (exitCode === undefined) child.kill();
}
