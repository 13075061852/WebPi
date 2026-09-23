// Real Electron motion checks. Optional --preview-file=... uses an untouched copy in an isolated profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const executableArgument = process.env.HALO_PACKAGED_EXE;
const executable = path.resolve(executableArgument || 'node_modules/electron/dist/electron.exe');
const packaged = Boolean(executableArgument);
const base = path.resolve('tmp/startup-recovery');
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
  const previewFile = process.argv.find(value => value.startsWith('--preview-file='))?.slice('--preview-file='.length);
  const html = previewFile ? fs.readFileSync(previewFile, 'utf8') : '<!doctype html><style>body{margin:0;background:#17242e;color:white}canvas{width:100%;height:100%}</style><canvas></canvas><script>const c=document.querySelector("canvas"),ctx=c.getContext("2d");let frame=0;function resize(){c.width=innerWidth;c.height=innerHeight}onresize=resize;resize();function draw(){frame++;ctx.fillStyle="#17242e";ctx.fillRect(0,0,c.width,c.height);for(let i=0;i<3500;i++){ctx.fillStyle="hsl("+(i+frame)%360+" 70% 50%)";ctx.fillRect((i*17+frame)%c.width,(i*31)%c.height,7,7)}requestAnimationFrame(draw)}draw();</script>';
  const probeScript = '<script>window.__motionProbe={id:Math.random(),resizes:0,frames:0};addEventListener("resize",()=>__motionProbe.resizes++);function probeFrame(){__motionProbe.frames++;requestAnimationFrame(probeFrame)}requestAnimationFrame(probeFrame);addEventListener("message",e=>{if(e.data==="motion-probe")parent.postMessage({type:"motion-probe",...__motionProbe,width:innerWidth,height:innerHeight},"*")});</script>';
  fs.writeFileSync(path.join(workspace, 'motion.html'), html + probeScript);
  await evaluate('document.documentElement.dataset.theme="light";document.querySelector("#treeRefresh").click();addEventListener("message",e=>{if(e.data?.type==="motion-probe")window.__guestMotion=e.data;})');
  await waitFor(() => evaluate('[...document.querySelectorAll("#wsTree .fname")].some(n=>n.textContent==="motion.html")'), 'Preview fixture missing');
  await evaluate('[...document.querySelectorAll("#wsTree .fname")].find(n=>n.textContent==="motion.html").closest(".trow").click()');
  await sleep(1200);
  const guest = async () => { await evaluate('window.__guestMotion=null;document.querySelector("#pvBody iframe").contentWindow.postMessage("motion-probe","*")'); return waitFor(() => evaluate('window.__guestMotion'), 'Preview did not respond'); };
  const initial = await guest();
  await evaluate(`(() => {
    window.__motionRecords=[];
    window.__modalRecords=[];
    const nativeAnimate=Element.prototype.animate;
    Element.prototype.animate=function(...args){
      const animation=nativeAnimate.apply(this,args);
      if(this.matches('.modal')){
        const record={created:performance.now()};window.__modalRecords.push(record);
        animation.finished.then(()=>{record.finished=performance.now();record.motionStart=animation.startTime}).catch(()=>{});
      }
      return animation;
    };
    const host=document.querySelector('#layout'),native=host.startViewTransition.bind(host);
    host.startViewTransition=options=>{
      const record={created:performance.now()};window.__motionRecords.push(record);
      const t=native(options);
      t.ready.then(()=>{
        record.ready=performance.now();
        record.masks=[...document.querySelectorAll('.device-switch-mask')].map(mask=>{const r=mask.getBoundingClientRect(),screen=mask.parentElement.getBoundingClientRect(),style=getComputedStyle(mask);return {opacity:+style.opacity,background:style.backgroundColor,covers:r.width>=screen.width-1&&r.height>=screen.height-1};});
        queueMicrotask(()=>{
          const groups=document.getAnimations().filter(a=>a.effect?.pseudoElement?.startsWith('::view-transition-group(layout-'));
          record.groups=groups.map(a=>({pseudo:a.effect.pseudoElement,keyframes:a.effect.getKeyframes()}));
          record.chrome=[...document.querySelectorAll('.device-morph-shell')].map(node=>({transform:getComputedStyle(node).transform,keyframes:node.getAnimations().find(a=>!a.effect.pseudoElement)?.effect.getKeyframes()}));
          Promise.allSettled(groups.map(a=>a.finished)).then(()=>{record.slideEnd=performance.now();record.motionStart=Math.min(...groups.map(a=>a.startTime).filter(t=>typeof t==='number'));});
        });
      }).catch(()=>{});
      t.finished.then(()=>record.finished=performance.now()).catch(()=>{});
      return t;
    };
  })()`);
  const results = [];
  for (const [name, selector] of [['sidebar-close','#btnSidebar'],['sidebar-open','#btnSidebar'],['tablet','.pvdev[data-dev="tablet"]'],['phone','.pvdev[data-dev="mobile"]'],['desktop','.pvdev[data-dev="desktop"]'],['preview-close','#btnPreviewToggle'],['preview-open','#btnPreviewToggle'],['settings-open','#btnSettings'],['settings-close','#settingsModal [data-close]'],['model-open','#btnModel'],['model-close','#modelModal [data-close]'],['think-open','#btnThink'],['think-close','#thinkModal [data-close]']]) {
    const sample = await evaluate(`(async()=>{
      const frames=[];window.__motionRecords=[];window.__modalRecords=[];let last=performance.now(),running=true;
      const tick=now=>{frames.push({at:now,previous:last,gap:now-last});last=now;if(running)requestAnimationFrame(tick)};requestAnimationFrame(tick);
      document.querySelector(${JSON.stringify(selector)}).click();
      await new Promise(r=>setTimeout(r,1000));running=false;
      const transitions=window.__motionRecords.map(t=>{const motion=frames.filter(f=>f.previous>=t.motionStart&&f.at<=t.slideEnd);return {...t,frames:motion.length,maxGap:Math.round(Math.max(0,...motion.map(f=>f.gap)))};});
      const modals=window.__modalRecords.map(t=>{const motion=frames.filter(f=>f.previous>=t.motionStart&&f.at<=t.finished);return {...t,frames:motion.length,maxGap:Math.round(Math.max(0,...motion.map(f=>f.gap)))};});
      return {transitions,modals,frames:frames.length};
    })()`);
    if (!name.includes('settings') && !name.includes('model') && !name.includes('think')) {
      assert.ok(sample.transitions[0]?.finished, `${name} must contain an actual completed transition`);
      assert.ok(sample.transitions[0].slideEnd - sample.transitions[0].ready >= 200, `${name} must not jump directly to the final layout`);
      assert.ok(sample.transitions[0].frames >= 8, `${name} must present intermediate animation frames`);
      for (const group of sample.transitions[0].groups) {
        if (group.keyframes.length < 2 || !group.keyframes[0].width) continue;
        assert.equal(group.keyframes[0].width, group.keyframes.at(-1).width, 'Snapshot width must remain fixed during compositor motion');
      }
      if (['tablet','phone','desktop'].includes(name)) {
        assert.ok(sample.transitions[0].masks.length,'Device content must be covered before snapshot movement');
        assert.ok(sample.transitions[0].masks.every(mask=>mask.opacity===1 && mask.covers && mask.background==='rgb(17, 19, 22)'), 'The device mask must be opaque and cover the whole screen: '+JSON.stringify(sample.transitions[0].masks));
        assert.equal(sample.transitions[0].chrome.length,2,'Device changes must morph chrome without stretching a page snapshot');
        assert.ok(sample.transitions[0].chrome.every(skin=>skin.transform==='none'&&skin.keyframes.length===2));
        assert.ok(!sample.transitions[0].groups.some(group=>group.pseudo.includes('layout-device')),'Device chrome must not be raster-scaled');
      } else assert.equal(sample.transitions[0].masks.length,0,'Sidebar transitions must keep their existing content behavior');
    } else {
      assert.ok(sample.modals[0]?.finished, `${name} must have a completed fade animation`);
      assert.ok(sample.modals[0].frames >= 8, `${name} must render intermediate fade frames`);
    }
    results.push({name, ...sample});
    assert.equal(await evaluate('document.querySelectorAll(".device-switch-mask").length'),0,'Completed transitions must remove their masks');
    assert.equal(await evaluate('document.querySelectorAll(".device-morph-overlay,.device-morph-hidden").length'),0,'Completed transitions must restore the live chrome');
  }
  // Capture real intermediate frames separately from the timing run.
  for (const [name, selector] of [['preview-close','#btnPreviewToggle'],['preview-open','#btnPreviewToggle'],['sidebar','#btnSidebar'],['phone','.pvdev[data-dev="mobile"]']]) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await waitFor(() => evaluate('document.getAnimations().some(a=>a.playState==="running"&&a.effect?.pseudoElement?.startsWith("::view-transition-group(layout-"))'), 'No running geometry animation');
    await evaluate('window.__pausedAnimations=document.getAnimations().filter(a=>a.effect?.pseudoElement||a.effect?.target?.closest(".device-morph-overlay"));for(const a of __pausedAnimations){a.pause();a.currentTime=110;}');
    if (name.startsWith('preview-')) {
      const coverage = await evaluate(`(()=>{
        const host=document.documentElement.classList.contains('layout-motion-global')?document.documentElement:document.querySelector('#layout');
        return {opacity:getComputedStyle(host,'::view-transition-old(layout-center)').opacity,
          clip:__pausedAnimations.some(a=>a.effect?.pseudoElement==='::view-transition-group(layout-center)'&&a.effect.getKeyframes().some(k=>k.clipPath)),
          device:document.querySelector('#pvBody .dev-shell').style.viewTransitionName};
      })()`);
      assert.equal(coverage.opacity,'1','Outgoing preview must remain painted behind the sliding chat');
      assert.equal(coverage.clip,true,'Preview reveal must track the chat edge');
      assert.equal(coverage.device,'none','Device must stay inside the preview snapshot');
    }
    if (name === 'phone') {
      const chrome=await evaluate('(()=>{const n=document.querySelector(".device-morph-shell"),s=getComputedStyle(n);return {transform:s.transform,radius:parseFloat(s.borderRadius),width:n.getBoundingClientRect().width,finalWidth:document.querySelector("#pvBody .dev-shell").getBoundingClientRect().width}})()');
      assert.equal(chrome.transform,'none','Shell edges must never be squeezed by scale');
      assert.ok(chrome.radius>18&&chrome.radius<43&&chrome.width>chrome.finalWidth,'Width and roundness must change in the same intermediate frame');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".device-switch-mask")).opacity'),'1','Content must stay covered at the animated midpoint');
    }
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(fixture, name+'-midpoint.png'),Buffer.from(shot.result.data,'base64'));
    await evaluate('for(const a of __pausedAnimations)a.play()');
    await waitFor(() => evaluate('!document.documentElement.classList.contains("layout-motion")'), 'Layout animation failed to clean up');
    if (name === 'phone') {
      assert.ok(Math.abs((await guest()).width-await evaluate('document.querySelector("#pvBody iframe").getBoundingClientRect().width'))<2,'Uncovered content must use the final viewport');
      const ready=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(fixture,'phone-ready.png'),Buffer.from(ready.result.data,'base64'));
    }
  }
  await evaluate('document.querySelector("#btnSidebar").click();document.querySelector(".pvdev[data-dev=desktop]").click()');
  await waitFor(() => evaluate('!document.documentElement.classList.contains("layout-motion") && document.querySelector("#pvBody").classList.contains("dev-desktop")'), 'Reset layout');
  // Check both directions for all three device pairs, including the handoff frame.
  await evaluate(`window.__paneRects=()=>Object.fromEntries(['sidebar','center','chat'].map(name=>{const r=document.querySelector('#'+name).getBoundingClientRect();return [name,{x:r.x,y:r.y,width:r.width,height:r.height}]}));
    window.__snapshotRects=()=>Object.fromEntries(['sidebar','center','chat'].map(name=>{
      const host=document.querySelector('#layout'),bounds=host.getBoundingClientRect(),style=getComputedStyle(host,'::view-transition-group(layout-'+name+')');
      const matrix=new DOMMatrix(style.transform),width=parseFloat(style.width),height=parseFloat(style.height);
      const origins=style.transformOrigin.split(' ').map((value,index)=>parseFloat(value)*(value.endsWith('%')?[width,height][index]/100:1));
      return [name,{x:bounds.x+matrix.e+origins[0]*(1-matrix.a)-origins[1]*matrix.c,y:bounds.y+matrix.f+origins[1]*(1-matrix.d)-origins[0]*matrix.b,width:width*matrix.a,height:height*matrix.d,origin:style.transformOrigin}];
    }));`);
  const chromeSamples=[];
  for(const mode of ['mobile','tablet','desktop','tablet','mobile','desktop']) {
    const before=await evaluate('(()=>{const n=document.querySelector("#pvBody .dev-shell"),r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,radius:parseFloat(getComputedStyle(n).borderRadius)}})()');
    const panesBefore=await evaluate('__paneRects()');
    await evaluate(`document.querySelector('.pvdev[data-dev="${mode}"]').click()`);
    await waitFor(()=>evaluate('document.querySelector(".device-morph-shell")?.getAnimations().some(a=>a.playState==="running"&&!a.effect.pseudoElement)'),'Chrome animation did not start');
    const samples=await evaluate(`(()=>{
      const animations=document.getAnimations().filter(a=>a.effect?.pseudoElement||a.effect?.target?.closest('.device-morph-overlay'));
      animations.forEach(a=>a.pause());window.__pausedAnimations=animations;
      const rect=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return {x:r.x,y:r.y,width:r.width,height:r.height,radius:parseFloat(s.borderRadius),border:parseFloat(s.borderTopWidth),transform:s.transform}};
      const final=rect(document.querySelector('#pvBody .dev-shell'));
      const frames=[0,40,80,140,210,280].map(time=>{animations.forEach(a=>a.currentTime=time);return {time,panes:__snapshotRects(),skins:[...document.querySelectorAll('.device-morph-shell')].map(rect)}});
      return {final,frames,panesFinal:__paneRects(),guests:document.querySelectorAll('.device-morph-overlay iframe,.device-morph-overlay webview').length};
    })()`);
    assert.equal(samples.guests,0,'Chrome copies must never create another embedded page');
    for(const [index,expected] of [[0,before],[samples.frames.length-1,samples.final]]) for(const skin of samples.frames[index].skins) {
      for(const property of ['x','y','width','height','radius']) assert.ok(Math.abs(skin[property]-expected[property])<.6,`${mode}: ${property} jumped at ${index===0?'start':'handoff'}: ${JSON.stringify({skin,expected})}`);
    }
    for(const frame of samples.frames) for(const skin of frame.skins) {
      assert.equal(skin.transform,'none');assert.equal(skin.border,samples.final.border,'Border thickness must stay constant');
      assert.ok(skin.width>=Math.min(before.width,samples.final.width)-.6&&skin.width<=Math.max(before.width,samples.final.width)+.6,'Chrome must not overshoot its bounds');
      assert.ok(skin.x>=frame.panes.center.x-.6&&skin.x+skin.width<=frame.panes.center.x+frame.panes.center.width+.6,`${mode} at ${frame.time}ms: device escapes the painted preview column: ${JSON.stringify({skin,panes:frame.panes})}`);
      assert.ok(Math.abs(frame.panes.center.x+frame.panes.center.width-frame.panes.chat.x)<.6,`${mode}: preview and chat snapshots must share a continuous boundary`);
    }
    for(const [frame,expected] of [[samples.frames[0],panesBefore],[samples.frames.at(-1),samples.panesFinal]]) for(const name of ['sidebar','center','chat']) {
      for(const property of ['x','y','width','height']) assert.ok(Math.abs(frame.panes[name][property]-expected[name][property])<.6,`${mode}: ${name} ${property} shifted at ${frame.time}ms: ${JSON.stringify({actual:frame.panes[name],expected:expected[name]})}`);
    }
    chromeSamples.push({mode,before,panesBefore,...samples});
    if(mode==='mobile'&&chromeSamples.length===1) for(const time of [0,140,280]) {
      await evaluate(`__pausedAnimations.forEach(a=>a.currentTime=${time})`);
      const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(fixture,`chrome-${time}.png`),Buffer.from(shot.result.data,'base64'));
    }
    await evaluate('__pausedAnimations.forEach(a=>a.play())');
    await waitFor(()=>evaluate('!document.documentElement.classList.contains("layout-motion")'),'Chrome handoff did not finish');
    assert.equal(await evaluate('document.querySelectorAll(".device-morph-overlay,.device-morph-hidden").length'),0);
  }
  // Open and close really animate; reversing a close preserves its current opacity.
  await evaluate('document.querySelector("#btnSettings").click()');
  await waitFor(() => evaluate('document.querySelector("#settingsModal").getAnimations().some(a=>a.playState==="running")'), 'Modal opening did not animate');
  const opening = await evaluate('(()=>{const m=document.querySelector("#settingsModal");m.getAnimations()[0].pause();m.getAnimations()[0].currentTime=80;return +getComputedStyle(m).opacity})()');
  assert.ok(opening > 0 && opening < 1, 'Modal opening needs a visible intermediate opacity');
  await evaluate('document.querySelector("#settingsModal").getAnimations().forEach(a=>a.finish())');await sleep(250);
  const frozen = await guest();await sleep(250);assert.equal((await guest()).frames,frozen.frames,'Preview stays still under a dialog');
  for (const theme of ['light','dark']) {
    await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));
    const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(fixture,'settings-'+theme+'.png'),Buffer.from(shot.result.data,'base64'));
  }
  const reversed = await evaluate(`(()=>{const m=document.querySelector('#settingsModal');m.querySelector('[data-close]').click();const a=m.getAnimations()[0];a.pause();a.currentTime=70;const before=+getComputedStyle(m).opacity;document.querySelector('#btnSettings').click();return {before,after:+getComputedStyle(m).opacity}})()`);
  assert.ok(reversed.before > 0 && reversed.before < 1, 'Modal close needs an intermediate opacity');
  assert.ok(Math.abs(reversed.before-reversed.after)<0.01,'Reopening must reverse without flashing');
  await sleep(350);assert.equal(await evaluate('document.querySelector("#settingsModal").hidden'),false);
  await evaluate('document.querySelector("#settingsModal [data-close]").click()');await sleep(350);
  assert.ok((await guest()).frames > frozen.frames, 'Closing the dialog resumes the same page');
  await evaluate('document.querySelector(".pvdev[data-dev=tablet]").click()');await sleep(80);
  await evaluate('document.querySelector(".pvdev[data-dev=mobile]").click();document.querySelector(".pvdev[data-dev=desktop]").click()');
  await waitFor(() => evaluate('!document.documentElement.classList.contains("layout-motion")'), 'Rapid toggles must settle');
  const final = await guest();assert.equal(final.id,initial.id,'Animations must not reload the preview');
  const viewport = await evaluate('(()=>{const f=document.querySelector("#pvBody iframe");return {width:f.getBoundingClientRect().width,style:f.getAttribute("style"),device:document.querySelector("#pvBody").classList.contains("dev-desktop")}})()');
  assert.ok(viewport.device);assert.ok(Math.abs(viewport.width-final.width)<2);assert.ok(!viewport.style?.includes('important'),'Temporary viewport size leaked');
  const interruptedReveal=await evaluate(`(async()=>{document.querySelector('.pvdev[data-dev=mobile]').click();await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Mask reveal did not start')),3000);function tick(){if(document.querySelector('.device-switch-mask')?.getAnimations().some(a=>a.playState==='running')){clearTimeout(timeout);resolve();}else requestAnimationFrame(tick)}tick()});document.querySelector('.pvdev[data-dev=desktop]').click();return [...document.querySelectorAll('.device-switch-mask')].every(m=>+getComputedStyle(m).opacity===1);})()`);
  assert.equal(interruptedReveal,true,'A new device choice must cover an in-flight reveal immediately');
  await waitFor(()=>evaluate('!document.documentElement.classList.contains("layout-motion")'),'Interrupted reveal did not finish');
  assert.equal(await evaluate('document.querySelectorAll(".device-switch-mask").length'),0);
  assert.equal((await guest()).id,initial.id,'Masked switching must preserve the page instance');
  await evaluate('document.querySelector("#btnSettings").click();document.querySelector("#settingsModal [data-close]").click()');
  await sleep(350);assert.equal(await evaluate('document.querySelector("#settingsModal").hidden'),true,'Closing before opening is ready must stay closed');
  await evaluate('document.querySelector(".pvdev[data-dev=mobile]").click()');await sleep(80);
  await evaluate('document.querySelector("#btnSettings").click()');await sleep(250);
  assert.equal(await evaluate('!!document.elementFromPoint(innerWidth/2,innerHeight/2).closest("#settingsModal")'),true,'A popup must stay above a concurrent workspace transition');
  await evaluate('document.querySelector("#settingsModal [data-close]").click()');
  await waitFor(()=>evaluate('!document.documentElement.classList.contains("layout-motion")'),'Concurrent motion did not finish');await sleep(250);
  await evaluate('document.querySelector(".pvdev[data-dev=desktop]").click()');await sleep(80);
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await waitFor(()=>evaluate('!document.documentElement.classList.contains("layout-motion")'),'Window resize must not leave a frozen overlay');
  assert.equal(await evaluate('document.querySelectorAll(".device-morph-overlay,.device-morph-hidden").length'),0,'Window resize must restore live device chrome');
  await send('Emulation.clearDeviceMetricsOverride');
  // Exercise losing visibility both during geometry motion and during uncovering.
  for(const [mode,phase] of [['mobile','chrome'],['desktop','reveal']]) {
    await evaluate(`document.querySelector('.pvdev[data-dev="${mode}"]').click()`);
    const selector=phase==='chrome'?'.device-morph-shell':'.device-switch-mask';
    await waitFor(()=>evaluate(`document.querySelector('${selector}')?.getAnimations().some(a=>a.playState==='running')`),`Missing ${phase} animation`);
    await evaluate('Object.defineProperty(document,"hidden",{value:true,configurable:true});document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor(()=>evaluate('!document.documentElement.classList.contains("layout-motion")&&!document.querySelector(".device-morph-overlay,.device-morph-hidden,.device-switch-mask")'),`Hidden window must clean up ${phase}`);
    await evaluate('delete document.hidden;document.dispatchEvent(new Event("visibilitychange"))');
    assert.equal((await guest()).id,initial.id,'Returning to the window must preserve the preview');
  }
  await evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=48;const context=canvas.getContext('2d');context.fillStyle='#387ac7';context.fillRect(0,0,48,48);const blob=await new Promise(r=>canvas.toBlob(r));const data=new DataTransfer();data.items.add(new File([blob],'motion-preview.png',{type:'image/png'}));document.querySelector('#input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
  await waitFor(()=>evaluate('!!document.querySelector(".attach-preview")'),'Image fixture did not attach');
  await evaluate('document.querySelector(".attach-preview").click()');
  await waitFor(()=>evaluate('document.querySelector(".image-viewer")?.getAnimations().some(a=>a.playState==="running")'),'Image viewer must animate when opening');
  await sleep(250);
  await evaluate('document.querySelector(".image-viewer").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
  assert.equal(await evaluate('document.querySelector(".image-viewer")?.open'),true,'Escape must play the close animation before removing the dialog');
  await waitFor(()=>evaluate('!document.querySelector(".image-viewer")'),'Image viewer failed to close');
  // A busy preview can leave its pause IPC unresolved. Device choices still need
  // to commit, and rapid clicks should settle on the last requested mode.
  const stalledMotion = await evaluate(`(async()=>{
    const {createLayoutMotion}=await import('./js/layout-motion.mjs');
    const motion=createLayoutMotion({setPaused:()=>new Promise(()=>{})});
    const body=document.querySelector('#pvBody');
    for(const device of ['tablet','mobile','desktop']) motion(()=>{body.dataset.stalledDevice=device},{device:true,maskPreview:true});
    const end=Date.now()+5500;
    while(Date.now()<end){
      if(body.dataset.stalledDevice==='desktop'&&!document.documentElement.classList.contains('layout-motion')&&!document.querySelector('.device-switch-mask')) return body.dataset.stalledDevice;
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    return {device:body.dataset.stalledDevice,mask:!!document.querySelector('.device-switch-mask'),motion:document.documentElement.classList.contains('layout-motion')};
  })()`);
  assert.equal(stalledMotion,'desktop','Unresponsive preview pause must not block device choices');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate('document.querySelector("#btnThink").click()');
  assert.equal(await evaluate('document.querySelector("#thinkModal").getAnimations().length'),0);
  await evaluate('document.querySelector("#thinkModal [data-close]").click()');
  assert.equal(await evaluate('document.querySelector("#thinkModal").hidden'),true);
  await evaluate('document.querySelector(".pvdev[data-dev=mobile]").click()');
  await waitFor(()=>evaluate('document.querySelector("#pvBody").classList.contains("dev-mobile")&&!document.querySelector(".device-switch-mask")'),'Reduced motion must also clean up its mask');
  const report={fixture,previewFile:previewFile||'generated canvas',initial,final,results,chromeSamples};
  fs.writeFileSync(path.join(fixture,'motion-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:true,fixture,results:results.map(r=>({name:r.name,motion:r.transitions.map(t=>({frames:t.frames,maxGap:t.maxGap,duration:Math.round(t.slideEnd-t.motionStart)})),modal:r.modals.map(t=>({frames:t.frames,maxGap:t.maxGap,duration:Math.round(t.finished-t.motionStart)}))}))}));
  await evaluate('setTimeout(()=>window.halo.close(),30);true');await waitFor(()=>exitCode!==undefined,'App did not close');

} finally {
  fs.writeFileSync(path.join(fixture, 'process.log'), output);
  ws?.close();
  if (exitCode === undefined) child.kill();
}
