// Isolated Electron theme selection and migration regression; never touches saved accounts or user projects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const executableArgument = process.env.HALO_PACKAGED_EXE;
const executable = path.resolve(executableArgument || 'node_modules/electron/dist/electron.exe');
const packaged = Boolean(executableArgument);
const base = path.join(os.tmpdir(), 'halo-themes-e2e');
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
// Seed only this disposable profile's image cache from repository originals.
// Theme selection must never depend on public hosts or a personal image cache.
const manifest = JSON.parse(fs.readFileSync('assets/theme-images.json','utf8'));
const cache = path.join(profile,'theme-images'); fs.mkdirSync(cache);
for(const [key, entry] of Object.entries(manifest)) {
  fs.copyFileSync(path.join('assets', key), path.join(cache, createHash('sha256').update(entry.url).digest('hex')));
}
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
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    }
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Page.enable');
  assert.match(page.url, /index.html$/);
  assert.ok(await evaluate('document.title && document.querySelector("#wsTree") && document.querySelector("#chat")'));

  await send('Emulation.setDeviceMetricsOverride', {width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const state = () => evaluate('({theme:document.documentElement.dataset.theme,wallpaper:document.documentElement.dataset.wallpaper||"",surface:document.documentElement.dataset.surface||"",saved:localStorage.getItem("halo-theme")})');
  const check = async (selected, palette = selected) => {
    const value = await state();
    assert.equal(value.theme, palette); assert.equal(value.surface, '');
    assert.equal(value.wallpaper, selected.startsWith('scene-') ? selected : '');
    assert.equal(value.saved, selected);
    assert.equal(await evaluate('!!document.querySelector(".glass-lens,.glass-surface,.glass-filter-defs,[data-theme-choice=glass]")'), false);
    assert.equal(await evaluate('performance.getEntriesByType("resource").some(r=>/theme-glass|glass-material|glass-backdrop/.test(r.name))'), false);
  };
  const click = selector => evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
  const tapToggle = async () => {
    const point = await evaluate('(()=>{const r=document.querySelector("#themeToggle").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
  };
  const motionDone = () => evaluate('!document.documentElement.classList.contains("theme-x") && !document.querySelector(".theme-ripple-anchor") && !document.getAnimations().some(a=>a.id.startsWith("theme-"))');
  const pauseMotion = () => waitFor(()=>evaluate('(()=>{const a=document.getAnimations().filter(a=>a.id==="theme-reveal"||a.id==="theme-wave");if(a.length!==2||a.some(e=>e.playState!=="running"))return false;window.__themeAnimations=a;for(const effect of a){effect.pause();effect.currentTime=0;}return true})()'),'Circular theme motion was not created');
  const choose = async selected => {
    await click('[data-theme-choice="'+selected+'"]');
    await check(selected, selected.startsWith('scene-') ? await evaluate('window.HALO_THEME_PALETTES['+JSON.stringify(selected)+']') : selected);
  };
  const openAppearance = async () => {
    await click('#btnSettings'); await click('[data-pane="appearance"]');
    await waitFor(()=>evaluate('document.querySelector("#settingsModal").classList.contains("show")'),'Settings did not open');
  };
  const capture = async filename => {
    await sleep(350);
    const screenshot = await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(fixture,filename),Buffer.from(screenshot.result.data,'base64'));
  };
  assert.equal((await state()).theme, 'light', 'Fresh profile starts light');
  await openAppearance();
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".theme-base-modes [data-theme-choice]")].map(b=>b.dataset.themeChoice)'), ['light','dark']);
  await choose('dark'); await capture('appearance-dark.png');
  await click('#settingsModal [data-close]');
  await waitFor(()=>evaluate('document.querySelector("#settingsModal").hidden'),'Settings must close before clicking the titlebar');
  const circles = [];
  for (const next of ['light','dark']) {
    await tapToggle(); await pauseMotion();
    const origin = await evaluate('(()=>{const r=document.querySelector("#themeToggle").getBoundingClientRect(),s=document.documentElement.style;return {x:r.x+r.width/2,y:r.y+r.height/2,actualX:parseFloat(s.getPropertyValue("--theme-origin-x")),actualY:parseFloat(s.getPropertyValue("--theme-origin-y")),width:innerWidth,height:innerHeight}})()');
    assert.equal(origin.actualX,origin.x); assert.equal(origin.actualY,origin.y);
    let previousRadius = -1;
    for (const time of [0,100,220,400,540,600,660,719]) {
      const frame = await evaluate('(()=>{for(const a of __themeAnimations)a.currentTime='+time+';const r=document.documentElement,s=getComputedStyle(r,"::view-transition-new(root)"),w=getComputedStyle(r,"::view-transition-group(theme-ripple)"),maximum=parseFloat(r.style.getPropertyValue("--theme-radius")),scale=new DOMMatrixReadOnly(w.transform).a;return {clip:s.clipPath,radius:maximum*scale,maximum,waves:w.backgroundImage,transform:s.transform,opacity:s.opacity}})()');
      assert.match(frame.clip,/^circle\(/); assert.equal(frame.transform,'none'); assert.equal(frame.opacity,'1');
      const radius = Number(frame.clip.match(/^circle\(([\d.]+)px/)[1]);
      assert.ok(radius>=previousRadius); previousRadius=radius;
      assert.ok(Math.abs(radius-frame.maximum*time/720)<.1, 'Sweep keeps the same speed through the last corner');
      assert.ok(Math.abs(frame.radius-radius)<2, 'Water front follows the expanding palette');
      assert.equal((frame.waves.match(/radial-gradient/g)||[]).length,3, 'Leading wave and two trailing ripples');
      circles.push({next,time,radius});
      if([220,600,660].includes(time)) {
        const shot=await send('Page.captureScreenshot',{format:'png'});
        const suffix=time===220?'':('-corner-'+time);
        fs.writeFileSync(path.join(fixture,'ripple-'+next+suffix+'.png'),Buffer.from(shot.result.data,'base64'));
      }
    }
    assert.ok(previousRadius>Math.hypot(origin.x,origin.height-origin.y),'Circle reaches the far corner');
    await evaluate('for(const a of __themeAnimations)a.play()');
    await waitFor(async()=>(await state()).saved===next && await evaluate('!document.documentElement.classList.contains("theme-x")'),'Titlebar did not finish theme switch');
    assert.equal(await motionDone(),true,'Completed animation leaves no layers');
    await check(next);
    assert.equal(await evaluate('[...document.querySelectorAll("#themeToggle .ic")].filter(e=>getComputedStyle(e).display!=="none").length'),1);
    assert.equal(await evaluate('document.querySelector("[data-theme-choice='+next+']").getAttribute("aria-pressed")'),'true');
  }
  await choose('light');
  for(let index=0;index<5;index++) await tapToggle();
  await waitFor(motionDone,'Rapid clicks left an active transition'); await check('dark');
  // A settings choice wins over an older snapshot callback, including before ready.
  await tapToggle(); await choose('dark'); await sleep(120); await check('dark');
  assert.equal(await motionDone(),true);
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await tapToggle(); await check('light'); assert.equal(await motionDone(),true,'Reduced motion switches immediately');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await evaluate('window.__startThemeTransition=document.startViewTransition;document.startViewTransition=undefined');
  await tapToggle(); await check('dark'); assert.equal(await motionDone(),true,'Unsupported transitions fall back');
  await evaluate('document.startViewTransition=window.__startThemeTransition');
  await tapToggle(); await pauseMotion();
  await send('Emulation.setDeviceMetricsOverride',{width:760,height:700,deviceScaleFactor:1,mobile:false});
  await waitFor(motionDone,'Resize did not clear transition'); await check('light');
  await tapToggle(); await pauseMotion();
  await evaluate('for(const a of __themeAnimations)a.currentTime=220');
  const compactShot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(fixture,'ripple-compact.png'),Buffer.from(compactShot.result.data,'base64'));
  await evaluate('for(const a of __themeAnimations)a.play()');
  await waitFor(motionDone,'Compact theme transition did not finish'); await check('dark');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  // Sample live playback as well as paused geometry: a correct last keyframe
  // alone cannot detect a stalled sweep that suddenly fills the final corner.
  await choose('light');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  const liveMotion=[];
  for(let index=0;index<4;index++) {
    const frames=await evaluate('(async()=>{const samples=[];let seen=false;return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Theme playback did not finish")),2500);function tick(t){const a=document.getAnimations().find(a=>a.id==="theme-reveal");if(a&&a.playState==="running"&&!a.pending){seen=true;samples.push({t,progress:a.effect.getComputedTiming().progress})}else if(seen&&!document.documentElement.classList.contains("theme-x")){clearTimeout(timer);resolve(samples);return}requestAnimationFrame(tick)}requestAnimationFrame(tick);document.querySelector("#themeToggle").click()})})()');
    assert.ok(frames.length>3,'Live sweep must draw intermediate frames');
    assert.ok(frames.at(-1).progress>.95,'Live sweep reaches the corner before cleanup');
    const gaps=frames.slice(1).map((frame,i)=>({ms:frame.t-frames[i].t,progress:frame.progress}));
    liveMotion.push({frames:frames.length,maxGap:Math.round(Math.max(...gaps.map(gap=>gap.ms))),cornerMaxGap:Math.round(Math.max(...gaps.filter(gap=>gap.progress>.7).map(gap=>gap.ms)))});
  }
  fs.writeFileSync(path.join(fixture,'live-motion.json'),JSON.stringify(liveMotion,null,2));
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  // Reopen a real saved glass preference; theme.js runs before the module app.
  await evaluate('localStorage.setItem("halo-theme","glass");location.reload()');
  await waitFor(()=>evaluate('!!window.__haloDispatch && document.querySelector("[data-theme-choice=light]").getAttribute("aria-pressed")==="true"'),'Legacy preference migration did not finish');
  await check('light');
  await openAppearance(); await capture('appearance-light-migrated.png');
  let count = 0;
  for (const category of ['nature','water','city','cosmos','oriental']) {
    await click('[data-theme-tab='+category+']');
    const ids = await evaluate('[...document.querySelectorAll("[data-theme-panel='+category+'] [data-theme-choice]")].map(b=>b.dataset.themeChoice)');
    assert.equal(ids.length,6);
    for (const id of ids) {
      await choose(id);
      await evaluate('(async()=>{for(const suffix of [".webp","-thumb.webp"]){const img=new Image();img.src="halo-theme://images/themes/collection/"+'+JSON.stringify(id)+'+suffix;await img.decode();if(!img.naturalWidth)throw Error("Image not decoded");}})()');
      count++;
    }
  }
  await choose('scene-moon');
  await evaluate('location.reload()');
  await waitFor(()=>evaluate('!!window.__haloDispatch && document.querySelector("[data-theme-choice=scene-moon]").getAttribute("aria-pressed")==="true"'),'Wallpaper did not survive reload');
  await check('scene-moon','dark');
  await openAppearance(); await choose('light');
  await send('Emulation.setDeviceMetricsOverride',{width:760,height:700,deviceScaleFactor:1,mobile:false});
  await capture('appearance-compact.png');
  assert.ok(await evaluate('(()=>{const r=document.querySelector("#settingsModal .modal-panel").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()'),'Compact appearance dialog overflows');
  assert.deepEqual(errors, [], 'No renderer runtime exceptions');
  console.log(JSON.stringify({ok:true,fixture,wallpapers:count,circles,liveMotion,checks:['constant-speed circular reveal through final corner','composited lake ripples','4 live sweeps at 1600x1000','rapid clicks/settings supersession','resize/reduced motion/unsupported fallback','legacy glass migration/reload','no removed resources','30 offline wallpapers and persistence','1280x900/760x700','no renderer exceptions']}));
  await evaluate('setTimeout(()=>window.halo.close(),30);true');
  await waitFor(()=>exitCode!==undefined,'App did not close');
} finally {
  fs.writeFileSync(path.join(fixture,'process.log'),output);
  ws?.close(); if(exitCode===undefined)child.kill();
}
