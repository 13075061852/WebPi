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
import PDFDocument from 'pdfkit';
import { PDFDocument as PDFEditor, degrees } from 'pdf-lib';
import { Document, Packer, Paragraph, PageBreak, TextRun } from 'docx';

const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-preview-normal-'));
const profile = path.join(fixture, 'profile'), agent = path.join(fixture, 'agent'), workspace = path.join(fixture, 'workspace');
for (const dir of [profile, agent, workspace]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
const gitConfig = path.join(fixture, 'empty-gitconfig'); fs.writeFileSync(gitConfig, '');
const guestSnapshot = `({id:window.fixtureId,scrollY:window.scrollY,draft:document.querySelector('#draft')?.value,touch:!!window.__haloTouchOn,touchStyle:!!document.getElementById('__halo-touch'),homeStyle:!!document.getElementById('__halo-home'),scrollbar:getComputedStyle(document.documentElement).scrollbarWidth,cursor:getComputedStyle(document.body).cursor,pointerTypes:window.pointerTypes})`;
const html = `<!doctype html><meta charset="utf-8"><title>Normal preview fixture</title>
<style>html{overflow-y:scroll}body{margin:0;padding:24px;background:#eef4ff;font:16px sans-serif;min-height:2400px}input{width:180px}h1{font-size:24px}button{display:block;margin-top:20px;width:160px;height:44px}</style>
<h1>Normal preview fixture</h1><input id="draft" value="original"><button id="mouse">Mouse target</button>
<script>window.fixtureId=Math.random().toString(36);window.pointerTypes=[];document.addEventListener('pointerdown',e=>window.pointerTypes.push(e.pointerType));
addEventListener('message',event=>{if(event.data?.type!=='normal-fixture-probe')return;if(typeof event.data.draft==='string')document.querySelector('#draft').value=event.data.draft;parent.postMessage({type:'normal-fixture-state',state:${guestSnapshot}},'*')});</script>`;
fs.writeFileSync(path.join(workspace, 'artifact.html'), html);
fs.writeFileSync(path.join(workspace, 'second.html'), html);
const pdf = new PDFDocument();
const chineseFont = 'C:/Windows/Fonts/simhei.ttf';
if (fs.existsSync(chineseFont)) pdf.font(chineseFont);
const pdfOutput = fs.createWriteStream(path.join(workspace, 'report.pdf')); pdf.pipe(pdfOutput);
// Dark paper/white text catches opaque selection colors that hide the raster.
pdf.rect(0,0,pdf.page.width,pdf.page.height).fill('#1c2946').fillColor('white');
pdf.text('Device preview page one');
if (fs.existsSync(chineseFont)) pdf.text('中文文字复制测试');
pdf.addPage().fillColor('black').text('Device preview page two'); pdf.end();
await once(pdfOutput, 'finish');
const rotatedPDF = await PDFEditor.load(fs.readFileSync(path.join(workspace, 'report.pdf')));
rotatedPDF.getPage(1).setRotation(degrees(90));
fs.writeFileSync(path.join(workspace, 'report.pdf'), await rotatedPDF.save());
const longPDF=new PDFDocument(),longOutput=fs.createWriteStream(path.join(workspace,'continuous.pdf'));
longPDF.pipe(longOutput);
for(let index=1;index<=20;index++){if(index>1)longPDF.addPage();longPDF.text(`Continuous page ${index}`);}
longPDF.end();await once(longOutput,'finish');
fs.writeFileSync(path.join(workspace, 'report.docx'), await Packer.toBuffer(new Document({ sections: [{children:Array.from({length:5},(_,index)=>new Paragraph({children:[...(index?[new PageBreak()]:[]),new TextRun('Document shell fixture')]}))}] })));
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
const resultDir = process.env.HALO_PREVIEW_RESULTS || path.join(root, 'test/results/preview-normal'); fs.mkdirSync(resultDir, { recursive: true });
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
async function rotation(kind) {
  await mode('tablet');
  await guestWheel(kind);
  await mode('mobile');
  const initial = await guestState(kind);
  for (const width of [1600, 1120]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate(`window.innerWidth === ${width}`), 'resized viewport');
    await sleep(100);
    await settled();
    await click('.pvdev[data-dev="mobile"]'); await settled();
    const geometry = await evaluate(`(()=>{const b=document.querySelector('#pvBody'),s=b.querySelector('.dev-shell').getBoundingClientRect(),g=b.querySelector('${kind}').getBoundingClientRect();return {landscape:b.classList.contains('dev-landscape'),width:g.width,height:g.height,shellWidth:s.width,shellHeight:s.height,pressed:document.querySelector('.pvdev[data-dev="mobile"]').getAttribute('aria-pressed')}})()`);
    assert.equal(geometry.landscape, true); assert.equal(geometry.pressed, 'true');
    assert.ok(geometry.width > geometry.height * 1.8, JSON.stringify(geometry));
    await guestWheel(kind);
    const current = await guestState(kind);
    assert.equal(current.id, initial.id); assert.equal(current.draft, initial.draft);
    await assertTouch(kind, true); await assertFooter();
    const alignment = await evaluate(`(()=>{const f=document.querySelector('.pv-devices').getBoundingClientRect(),buttons=[...document.querySelectorAll('.pvdev')].map(n=>n.getBoundingClientRect());return {group:(Math.min(...buttons.map(r=>r.left))+Math.max(...buttons.map(r=>r.right)))/2,footer:(f.left+f.right)/2,count:document.querySelectorAll('.pv-devices button').length,icons:document.querySelectorAll('.pvdev[data-dev="mobile"] svg').length}})()`);
    assert.ok(Math.abs(alignment.group - alignment.footer) < 1, JSON.stringify(alignment));
    assert.equal(alignment.count, 4); assert.equal(alignment.icons, 1);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".pv-phone-icon")).transform'), 'matrix(0, -1, 1, 0, 0, 0)');
    await screenshot(`landscape-${kind}-${width}`);
    await mode('desktop');
    assert.equal(await evaluate('document.querySelector(".pvdev[data-dev=mobile]").dataset.orientation'), 'landscape');
    await mode('mobile');
    assert.equal(await evaluate('document.querySelector("#pvBody").classList.contains("dev-landscape")'), true);
    await click('.pvdev[data-dev="mobile"]'); await settled();
    assert.equal(await evaluate('document.querySelector("#pvBody").classList.contains("dev-landscape")'), false);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".pv-phone-icon")).transform'), 'none');
    if (width === 1120) await screenshot(`portrait-${kind}-${width}`);
  }
  // Rapid toggles must settle on the last request without reloading the guest.
  await evaluate(`document.querySelector('.pvdev[data-dev="mobile"]').click();document.querySelector('.pvdev[data-dev="mobile"]').click()`); await settled();
  assert.equal(await evaluate('document.querySelector("#pvBody").classList.contains("dev-landscape")'), false);
  assert.equal((await guestState(kind)).id, initial.id);
  await mode('normal');
  pass(`${kind} rotates landscape/portrait at wide and narrow sizes, keeps input and page, preserves orientation across modes`);
}
async function guestWheel(kind) {
  const before=(await guestState(kind)).scrollY;
  const point=await evaluate(`(()=>{const r=document.querySelector('#pvBody ${kind}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+90}})()`);
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
  await command('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:200});
  await until(async()=> (await guestState(kind)).scrollY>before+20,`${kind} wheel in tablet/phone`);
}
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
    assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, `${a.name} overlaps ${b.name}: ${JSON.stringify(footer)}`);
  }
  measurements.push({ footer }); return footer.center;
}
async function screenshot(name) {
  const shot = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(resultDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
}
async function copyPDFText(expected) {
  await until(()=>evaluate(`Array.from(document.querySelectorAll('.pdf-text-layer span')).some(n=>n.textContent===${JSON.stringify(expected)})`),'PDF selectable text');
  const target = await evaluate(`(()=>{const n=Array.from(document.querySelectorAll('.pdf-text-layer span')).find(n=>n.textContent===${JSON.stringify(expected)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,rotation:n.closest('.pdf-text-layer').dataset.mainRotation}})()`);
  const vertical=target.rotation==='90';
  const start=vertical?{x:target.x+target.width/2,y:target.y+2}:{x:target.x+2,y:target.y+target.height/2};
  const end=vertical?{x:start.x,y:target.y+target.height-0.1}:{x:target.x+target.width-0.1,y:start.y};
  await command('Emulation.setFocusEmulationEnabled',{enabled:true});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...start});
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
  for(let step=1;step<=8;step++) {await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+(end.x-start.x)*step/8,y:start.y+(end.y-start.y)*step/8,button:'left',buttons:1});await sleep(20);}
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...end,button:'left',clickCount:1});
  const selection=await evaluate('getSelection().toString().trim()');
  if(selection!==expected) await screenshot('pdf-selection-failure');
  assert.equal(selection,expected,`Mouse selection: ${JSON.stringify(target)}`);
  // Capture the native copy event without modifying the user's system clipboard.
  await evaluate(`window.__pdfCopy=null;document.addEventListener('copy',e=>{window.__pdfCopy={text:getSelection().toString().trim(),trusted:e.isTrusted};e.preventDefault()},{once:true})`);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'c',code:'KeyC',windowsVirtualKeyCode:67,modifiers:2});
  assert.deepEqual(await evaluate('window.__pdfCopy'),{text:expected,trusted:true});
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
  if (!process.argv.includes('--documents-only')) {
  await click('#btnPreviewToggle'); await settled(); await mode('normal');
  const empty = await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.pv-gscreen'));return {border:parseFloat(s.borderTopWidth),radius:parseFloat(s.borderRadius),shadow:s.boxShadow,stands:[...document.querySelectorAll('.pv-gneck,.pv-gbase')].map(n=>getComputedStyle(n).display)}})()`);
  assert.equal(empty.border, 0); assert.equal(empty.radius, 0); assert.equal(empty.shadow, 'none'); assert.ok(empty.stands.every(display => display === 'none'));
  const assertEmptyFills = async () => {
    const size = await evaluate(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]};return {body:rect(document.querySelector('#pvBody')),screen:rect(document.querySelector('.pv-gscreen'))}})()`);
    size.body.forEach((value,i)=>assert.ok(Math.abs(value-size.screen[i])<1,JSON.stringify(size)));
  };
  await assertEmptyFills();
  await assertFooter();
  // Keep the supported window width: below 1120px the app intentionally folds
  // preview. A wider sidebar gives the same 314px preview without that race.
  await evaluate(`document.querySelector('#layout').style.setProperty('--sidebar-size','326px')`);
  await sleep(120); await settled();
  const centerWidth = await assertFooter(); assert.ok(centerWidth <= 320 && centerWidth >= 300, `Narrow preview fixture expected around 314px, got ${centerWidth}`);
  await assertEmptyFills();
  await screenshot('normal-empty'); pass('Desktop remains default; normal empty state and 314px footer have no device outline or overlap');
  await evaluate(`document.querySelector('#layout').style.removeProperty('--sidebar-size')`);
  await evaluate(`(()=>{
    window.__emptySnapshotCount=0;window.__emptyLiveFrames=[];
    for(const host of [document,document.querySelector('#layout')])if(host.startViewTransition){const native=host.startViewTransition.bind(host);host.startViewTransition=(...args)=>{window.__emptySnapshotCount++;return native(...args)}}
    const layout=document.querySelector('#layout'),native=layout.animate.bind(layout);
    layout.animate=(...args)=>{const a=native(...args);const sample=()=>{if(a.playState!=='running')return;__emptyLiveFrames.push([...document.querySelectorAll('#sidebar,#center,#chat')].map(n=>({height:n.getBoundingClientRect().height,untransformed:new DOMMatrix(getComputedStyle(n).transform).isIdentity})));requestAnimationFrame(sample)};requestAnimationFrame(sample);return a};
  })()`);

  for (const [width,height] of [[1600,900],[1120,900],[1120,560]]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(120); await settled();
    for (const device of ['desktop','tablet','mobile']) {
      await mode(device);
      if (device==='mobile' && await evaluate('document.querySelector("#pvBody").classList.contains("dev-landscape")')) { await click('.pvdev[data-dev="mobile"]'); await settled(); }
      const lock = await evaluate(`(()=>{const b=document.querySelector('#pvBody').getBoundingClientRect(),s=document.querySelector('.pv-gscreen').getBoundingClientRect(),c=document.querySelector('.pv-lock-clock').getBoundingClientRect(),h=document.querySelector('.pv-lock-hint').getBoundingClientRect();return {time:document.querySelector('.pv-lock-time').textContent,date:document.querySelector('.pv-lock-date').textContent,width:s.width,height:s.height,inside:s.left>=b.left&&s.right<=b.right&&s.top>=b.top&&s.bottom<=b.bottom,copyFits:c.bottom<h.top&&c.top>=s.top}})()`);
      assert.match(lock.time,/^\d{2}:\d{2}$/); assert.ok(lock.date.includes('星期'));
      assert.ok(lock.inside && lock.copyFits && lock.width>80 && lock.height>80, JSON.stringify({width,height,device,lock}));
      await screenshot(`lock-${device}-${width}-${height}`);
    }
    await click('.pvdev[data-dev="mobile"]'); await settled();
    const landscapeLock = await evaluate(`(()=>{const s=document.querySelector('.pv-gscreen').getBoundingClientRect(),c=document.querySelector('.pv-lock-clock').getBoundingClientRect(),h=document.querySelector('.pv-lock-hint').getBoundingClientRect();return {width:s.width,height:s.height,fits:c.bottom<h.top}})()`);
    assert.ok(landscapeLock.width>landscapeLock.height*1.8 && landscapeLock.fits, JSON.stringify(landscapeLock));
    await screenshot(`lock-landscape-${width}-${height}`);
    await click('.pvdev[data-dev="mobile"]'); await settled();
  }
  await command('Emulation.setDeviceMetricsOverride', { width:1120,height:900,deviceScaleFactor:1,mobile:false });
  await sleep(120); await mode('normal');
  await assertEmptyFills();
  const emptyMotion = await evaluate('({snapshots:__emptySnapshotCount,frames:__emptyLiveFrames})');
  assert.equal(emptyMotion.snapshots,0,'Empty device switches must never snapshot/scale workspace text');
  assert.ok(emptyMotion.frames.length>8,'Empty device choices retain real intermediate animation frames');
  assert.ok(emptyMotion.frames.every(frame=>frame.every(pane=>pane.untransformed)),'Live pane text must remain untransformed');
  pass('Empty device lock screens show local time/date and fit desktop, tablet, phone portrait/landscape at wide, narrow and short viewports');
  await evaluate(`document.documentElement.dataset.theme='light'`);
  for (const device of ['desktop','tablet','mobile']) {
    await mode(device); await screenshot(`lock-${device}-light`);
    assert.ok(await evaluate(`(()=>{const s=document.querySelector('.pv-gscreen').getBoundingClientRect();return s.width>80&&s.height>80&&getComputedStyle(document.querySelector('.pv-lock-time')).color==='rgb(255, 255, 255)'})()`));
  }
  await evaluate(`document.documentElement.dataset.theme='dark'`); await mode('normal');

  await treeFile('artifact.html');
  await until(async () => (await guestState('iframe'))?.id, 'HTML fixture ready');
  await guestState('iframe', 'retained input');
  const initialHTML = await guestState('iframe');
  await rotation('iframe');
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
  await assertTouch('iframe', false); await settled(); await assertNormal('iframe'); pass('Opening a new HTML preview during mobile-to-normal switching finishes with touch disabled');

  await evaluate(`(()=>{const d=window.__haloDispatch,text=${JSON.stringify(`[Local fixture](${websiteURL})`)};d({type:'agent_start'});d({type:'message_start',message:{role:'assistant',content:[]}});d({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});d({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'endTurn'}});d({type:'agent_end',messages:[],willRetry:false});d({type:'agent_settled'});})()`);
  await until(() => evaluate(`[...document.querySelectorAll('.md a')].some(link=>link.href===${JSON.stringify(websiteURL)})`), 'website link');
  await evaluate(`[...document.querySelectorAll('.md a')].find(link=>link.href===${JSON.stringify(websiteURL)}).click()`); await settled();
  await until(() => evaluate(`document.querySelector('#pvBody webview')?.getTitle()==='Normal preview fixture'`), 'webview ready');
  await guestState('webview', 'retained website input');
  const initialWeb = await guestState('webview'), initialLoads = websiteLoads;
  await rotation('webview');
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
  } else {
    await click('#btnPreviewToggle'); await settled(); await mode('normal');
    await evaluate(`document.documentElement.dataset.theme='light';document.documentElement.dataset.surface='glass'`);
    await until(() => evaluate('document.querySelector(".pv-devices").classList.contains("glass-surface")'), 'glass document fixture');
  }

  for (const name of ['report.pdf','report.docx']) {
    await treeFile(name);
    const isPDF=name.endsWith('.pdf');
    await until(()=>evaluate(isPDF ? 'document.querySelector(".document-canvas img")?.naturalWidth>0' : 'document.querySelector(".office-frame")?.contentDocument?.body?.textContent.includes("Document shell fixture")'),'document rendered');
    if(!isPDF) await evaluate('window.__documentFrame=document.querySelector(".office-frame")');
    await evaluate(`(()=>{
      window.__documentSnapshots=0;window.__documentFrames=[];
      for(const host of [document,document.querySelector('#layout')])if(host.startViewTransition){const native=host.startViewTransition.bind(host);host.startViewTransition=(...args)=>{window.__documentSnapshots++;return native(...args)}}
      window.__sampleDocuments=true;
      const sample=()=>{if(!window.__sampleDocuments)return;if(document.documentElement.classList.contains('layout-motion'))window.__documentFrames.push({live:document.documentElement.classList.contains('layout-motion-live'),morph:!!document.querySelector('.device-morph-overlay,.device-switch-mask'),content:!!document.querySelector('.document-canvas img')?.naturalWidth||!!document.querySelector('.office-frame')?.contentDocument?.body?.textContent.includes('Document shell fixture'),panes:[...document.querySelectorAll('#sidebar,#center,#chat')].every(n=>new DOMMatrix(getComputedStyle(n).transform).isIdentity)});requestAnimationFrame(sample)};requestAnimationFrame(sample);
    })()`);
    for(const width of [1600,1120]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await settled();
      for(const device of ['desktop','tablet','mobile','mobile','normal']) {
        if(device==='tablet') {
          await click('.pvdev[data-dev="tablet"]');
          await until(()=>evaluate('document.documentElement.classList.contains("layout-motion-live")'),'live document transition');
          await screenshot(`document-${name}-${width}-switching`);
          await settled();
        } else await mode(device);
        const geometry=await evaluate(`(()=>{const shell=document.querySelector('.dev-document-shell'),screen=shell.querySelector('.dev-screen').getBoundingClientRect(),content=shell.querySelector('${isPDF?'.document-preview':'.office-frame'}').getBoundingClientRect(),nav=shell.querySelector('nav')?.getBoundingClientRect();return {shell:!!shell,width:screen.width,height:screen.height,inside:Math.abs(content.left-screen.left)<1&&Math.abs(content.top-screen.top)<1&&Math.abs(content.right-screen.right)<1&&Math.abs(content.bottom-screen.bottom)<1,nav:!nav||nav.bottom<=screen.bottom+1,same:${isPDF?'true':'window.__documentFrame===document.querySelector(".office-frame")'}}})()`);
        assert.ok(geometry.shell&&geometry.inside&&geometry.nav&&geometry.same&&geometry.width>50&&geometry.height>50,JSON.stringify({name,device,geometry}));
        if(isPDF) {
          const area=await evaluate(`(()=>{const c=document.querySelector('.document-canvas'),r=c.getBoundingClientRect();c.scrollTop=0;return {x:r.x+r.width/2,y:r.y+50,scrollable:c.scrollHeight>c.clientHeight+20}})()`);
          if(area.scrollable) {
            await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:area.x,y:area.y});
            await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:area.x,y:area.y,deltaX:0,deltaY:150});
            await until(()=>evaluate(`document.querySelector('.document-canvas').scrollTop>5`),`PDF wheel: ${device}/${width}`,3000);
          }
          await copyPDFText('Device preview page one');
        }
        else {
          await until(()=>evaluate(`(()=>{const doc=document.querySelector('.office-frame').contentDocument,content=doc.querySelector('#content'),page=doc.querySelector('section.docx');if(!page)return false;const c=content.getBoundingClientRect(),p=page.getBoundingClientRect();return content.scrollWidth<=content.clientWidth+1&&p.left>=c.left&&p.right<=c.right&&p.width>30})()`),'Word fits width after device/viewport change');
          const point=await evaluate(`(()=>{const f=document.querySelector('.office-frame'),r=f.getBoundingClientRect();f.contentDocument.querySelector('#content').scrollTop=0;return {x:r.x+r.width/2,y:r.y+90}})()`);
          await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
          await command('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:350});
          await until(()=>evaluate(`document.querySelector('.office-frame').contentDocument.querySelector('#content').scrollTop>5`),`Word wheel down: ${device}/${width}`,3000);
          const scrolled=await evaluate(`document.querySelector('.office-frame').contentDocument.querySelector('#content').scrollTop`);
          assert.ok(scrolled>=349&&scrolled<=351,'Wheel delta must be applied once');
          await command('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-200});
          await until(()=>evaluate(`document.querySelector('.office-frame').contentDocument.querySelector('#content').scrollTop<${scrolled-100}`),`Word wheel up: ${device}/${width}`,3000);
        }
        await screenshot(`document-${name}-${device}-${width}`);
      }
    }
    const motion=await evaluate('window.__sampleDocuments=false;({snapshots:window.__documentSnapshots,frames:window.__documentFrames})');
    assert.equal(motion.snapshots,0,`${name}: document switching must not capture/scale workspace textures`);
    assert.ok(motion.frames.filter(f=>f.live).length>=8&&motion.frames.every(f=>!f.morph&&f.panes&&f.content),`${name}: live untransformed, nonblank frames: ${JSON.stringify(motion)}`);
    if(isPDF) {
      assert.equal(await evaluate('document.querySelectorAll(".pdf-page").length'),2,'Every PDF page has a place in the continuous scroll');
      assert.equal(await evaluate('!!document.querySelector("#docNext,#docPrev,.document-pages,.document-preview nav")'),false,'No pagination controls');
      const firstImage=await evaluate('document.querySelector(".pdf-page img").src');
      await evaluate(`document.querySelector('.pdf-page[data-page="2"]').scrollIntoView({block:'start'})`);
      await until(()=>evaluate(`document.querySelector('.pdf-page[data-page="2"] img')?.naturalWidth>0`),'PDF second page loads by scrolling');
      await copyPDFText('Device preview page two');
      assert.equal(await evaluate('document.querySelector(".pdf-page img").src'),firstImage,'Scrolling to another page preserves earlier content');
      assert.equal(await evaluate(`(()=>{const pages=[...document.querySelectorAll('.pdf-page')];return pages[1].getBoundingClientRect().top>pages[0].getBoundingClientRect().bottom})()`),true,'Pages stack vertically');
      assert.equal(await evaluate('document.querySelector(".pdf-page[data-page=\\"2\\"] .pdf-text-layer").dataset.mainRotation'),'90');
      if(fs.existsSync(chineseFont)) await copyPDFText('中文文字复制测试');
      await screenshot('pdf-text-selection');
    }
  }
  await treeFile('continuous.pdf');
  await until(()=>evaluate('document.querySelector(".pdf-page img")?.naturalWidth>0'),'long PDF first page');
  assert.equal(await evaluate('document.querySelectorAll(".pdf-page").length'),20);
  assert.ok(await evaluate('document.querySelectorAll(".pdf-page img").length<20'),'Long PDF starts without rendering every page');
  await evaluate(`document.querySelector('.pdf-page[data-page="20"]').scrollIntoView({block:'start'})`);
  await until(()=>evaluate(`document.querySelector('.pdf-page[data-page="20"] img')?.naturalWidth>0`),'last PDF page loads by scrolling');
  await copyPDFText('Continuous page 20');
  assert.ok(await evaluate('document.querySelectorAll(".pdf-page img").length<20'),'Jumping to the end does not render every intermediate page');
  await screenshot('pdf-continuous-last-page');
  pass('PDF continuous scrolling without pagination controls, retained pages, wheel and copy across devices/rotated text; Word fit and wheel scrolling');
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  fs.writeFileSync(path.join(resultDir, 'report.json'), JSON.stringify({ fixture, passed, websiteLoads, measurements }, null, 2));
  console.log(`PASS ordinary preview: ${passed.length} checks; ${resultDir}`);
  await evaluate('setTimeout(()=>window.halo.close(),30);true'); await until(() => exitCode !== undefined, 'Electron shutdown');
} finally {
  fs.writeFileSync(path.join(resultDir, 'process.log'), output);
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear(); ws?.close(); if (exitCode === undefined) child.kill(); website.closeAllConnections(); website.close();
}
