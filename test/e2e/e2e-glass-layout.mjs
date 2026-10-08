/** Pane folding in every theme: real frames, compositor pixels, and preview continuity. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const theme = process.argv.find(argument => argument.startsWith('--theme='))?.slice('--theme='.length) || 'glass';
assert.ok(['light', 'dark', 'glass'].includes(theme), 'Use --theme=light|dark|glass');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const fixture = mkdtempSync(path.join(tmpdir(), `halo-${theme}-layout-`));
const profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace'), agent = path.join(fixture, 'agent');
const output = path.resolve('test/results/glass-layout', theme);
for (const dir of [profile, workspace, agent, output]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }] }));
writeFileSync(path.join(fixture, 'npmrc'), '');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE)/i.test(key)));
Object.assign(env, {
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  XDG_CONFIG_HOME: path.join(fixture, 'config'), GH_CONFIG_DIR: path.join(fixture, 'gh'),
  GCM_CREDENTIAL_STORE: 'plaintext', GCM_PLAINTEXT_STORE_PATH: path.join(fixture, 'empty-gcm-store'),
  NPM_CONFIG_USERCONFIG: path.join(fixture, 'npmrc'), PI_CODING_AGENT_DIR: agent,
  PI_HALO_PI_PATH: path.resolve('test/fixtures/pi-sdk.js'), PI_OFFLINE: '1',
});
const electron = spawn(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron',
  ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', ws, serial = 0;
for (const stream of [electron.stdout, electron.stderr]) stream.on('data', data => { log = (log + data).slice(-12000); });
const pending = new Map(), exceptions = [], samples = [], continuous = [];
const skipPixels = process.argv.includes('--skip-pixels');
const controls = {
  sidebar: { selector: '#btnSidebar', bodyClass: 'sb-collapsed' },
  preview: { selector: '#btnPreviewToggle', bodyClass: 'preview-collapsed' },
  focus: { selector: '#btnFocus', bodyClass: 'focus-mode' },
};
const action = (name, on) => name === 'focus' ? (on ? 'enter' : 'exit') : (on ? 'close' : 'open');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert.equal(response.result?.exceptionDetails, undefined, JSON.stringify(response.result?.exceptionDetails));
  return response.result?.result?.value;
}
async function until(expression, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(20);
  }
  throw Error(`Timed out: ${label}\n${log}`);
}
async function clickToggle(name = 'preview') {
  const point = await evaluate(`(() => {const r=document.querySelector('${controls[name].selector}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function settled(name, collapsed) {
  await until(`!document.documentElement.classList.contains('layout-motion') && document.body.classList.contains('${controls[name].bodyClass}')===${collapsed} && !document.querySelector('.device-switch-mask')`, `${name} fold completes`);
  if (name === 'preview') {
    assert.equal(await evaluate(`document.querySelector('#btnPreviewToggle').getAttribute('aria-expanded')`), String(!collapsed));
    assert.equal(await evaluate(`document.querySelector('#center').inert`), collapsed);
  }
  assert.equal(await evaluate(`document.querySelectorAll('.device-switch-mask,.device-morph-overlay,.device-morph-hidden').length`), 0, 'No transition overlays remain');
  assert.equal(await evaluate(`document.querySelectorAll('.layout-motion-live,.layout-live-visible').length`), 0, 'Live transition classes cleaned');
  assert.equal(await evaluate(`['#sidebar','#center','#chat'].some(s=>document.querySelector(s).style.viewTransitionName)`), false, 'Snapshot names cleaned');
  assert.deepEqual(await evaluate('window.__forbiddenTransitions'), [], 'Pane folding must never create View Transition snapshots');
  if (theme === 'glass') await until(`['#sidebar','#chat','.input-shell'].every(s=>{const e=document.querySelector(s);return e.offsetWidth<2||!e.checkVisibility()||getComputedStyle(e).backdropFilter.includes('url(')})`, 'Visible SVG optics restored');
}
function assertLiveState(state, label) {
  assert.equal(state.snapshots, 0, `${label}: no snapshot animation`);
  assert.equal(state.transitionCalls, 0, `${label}: no View Transition capture`);
  for (const pane of state.panes) assert.ok(pane.unscaled, `${label}: ${pane.name} must not scale text (${pane.transform})`);
  for (const [index, marker] of state.markers.entries()) {
    if (index === 0 && marker.visibleWidth < 4) continue;
    assert.equal(marker.height, 12, `${label}: marker ${index} keeps its DOM height`);
    assert.ok(Math.abs(marker.y - state.baselineY[index]) < 1, `${label}: marker ${index} stays at the same vertical position`);
  }
}
async function recordContinuous(name, collapsed, label) {
  await evaluate(`(() => {
    window.__liveRun={frames:[__glassLayoutState()],done:false};
    const started=performance.now();let settledFrames=0;
    function tick(){
      const state=__glassLayoutState();__liveRun.frames.push(state);
      if(!state.active&&document.body.classList.contains('${controls[name].bodyClass}')===${collapsed})settledFrames++;else settledFrames=0;
      if(settledFrames>=3||performance.now()-started>6500){__liveRun.done=true;return;}
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })()`);
  await clickToggle(name);
  await until('__liveRun.done', `${label}: consecutive frames`, 8000);
  const run = await evaluate('__liveRun');
  const active = run.frames.filter(frame => frame.active);
  assert.ok(active.length >= 3, `${label}: collect genuine running frames`);
  const panes = name === 'focus' ? ['sidebar', 'center'] : [name === 'sidebar' ? 'sidebar' : 'center'];
  for (const pane of panes) {
    const widths = run.frames.map(frame => frame.panes.find(item => item.name === pane).width);
    assert.ok(widths.some(width => width > Math.min(...widths) + 1 && width < Math.max(...widths) - 1), `${label}: ${pane} width really interpolates`);
  }
  for (const [index, frame] of run.frames.entries()) assertLiveState(frame, `${label}/frame-${index}`);
  await settled(name, collapsed);
  continuous.push({ label, ...run });
  console.log(`PASS ${label}: ${run.frames.length} consecutive frames without snapshots`);
}
async function pixels(base64) {
  return evaluate(`(async () => {
    const image=new Image();image.src='data:image/png;base64,${base64}';await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const {data}=context.getImageData(0,0,canvas.width,canvas.height);
    return [[253,0,181],[0,190,247]].map(color=>{
      let x0=Infinity,y0=Infinity,x1=-1,y1=-1,count=0;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
        const i=(y*canvas.width+x)*4;
        if(color.every((c,k)=>Math.abs(data[i+k]-c)<12)){
          x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);count++;
        }
      }
      return {x:x0,y:y0,width:x1-x0+1,height:y1-y0+1,count};
    });
  })()`);
}

try {
  let target;
  for (let attempt = 0; attempt < 80 && !target; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && item.url.endsWith('index.html')); } catch {}
    if (!target) await sleep(250);
  }
  assert.ok(target, `Electron renderer ready\n${log}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(Error(JSON.stringify(message.error))); else request.resolve(message);
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(`!!window.__haloDispatch && window.halo.startupState().then(r=>r.data.ready)`, 'startup', 20000);
  assert.deepEqual((await evaluate('window.halo.githubStatus()'))?.data?.accounts, [], 'Offline test must not read personal GCM accounts');
  await evaluate(`(() => {
    document.querySelector('[data-theme-choice="${theme}"]').click();
    const d=window.__haloDispatch;
    const text=Array.from({length:18},(_,i)=>'### 流程 '+(i+1)+'\\n\\n检查材料、设备和生产流程，保持正文清晰、段落连续。\\n\\n| 环节 | 内容 |\\n| --- | --- |\\n| 配料 | 检查材料配比 |\\n| 挤出 | 控制设备参数 |').join('\\n\\n');
    d({type:'agent_start'});d({type:'message_start',message:{role:'assistant',content:[]}});
    d({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});
    d({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'endTurn'}});
    d({type:'agent_end',messages:[],willRetry:false});d({type:'agent_settled'});
    // Markers live in real footers; screenshot pixels catch stretching beyond DOM geometry.
    for(const [selector,color] of [['#modelCard','rgb(253,0,181)'],['.composer-balances','rgb(0,190,247)']]){
      const parent=document.querySelector(selector);parent.style.position='relative';
      const marker=document.createElement('i');marker.className='glass-layout-pixel-probe';
      marker.style.cssText='position:absolute;right:4px;top:6px;width:12px;height:12px;background:'+color+';z-index:20;pointer-events:none';
      parent.append(marker);
    }
    window.__glassLayoutState=()=>{
      const host=document.querySelector('#layout');
      return {
        active:document.documentElement.classList.contains('layout-motion'),
        live:document.documentElement.classList.contains('layout-motion-live'),
        previewCollapsed:document.body.classList.contains('preview-collapsed'),
        sidebarCollapsed:document.body.classList.contains('sb-collapsed'),
        focusCollapsed:document.body.classList.contains('focus-mode'),
        transitionCalls:window.__forbiddenTransitions?.length||0,
        snapshots:document.getAnimations().filter(a=>a.effect?.pseudoElement?.includes('view-transition')).length,
        baselineY:window.__markerBaselineY,
        sources:[...host.querySelectorAll('.glass-surface')].filter(e=>e.checkVisibility()).map(e=>({id:e.id||e.className,filter:getComputedStyle(e).backdropFilter})),
        panes:['sidebar','center','chat'].map(name=>{const e=document.querySelector('#'+name),r=e.getBoundingClientRect(),transform=getComputedStyle(e).transform,m=new DOMMatrix(transform);return {name,x:r.x,y:r.y,width:r.width,height:r.height,transform,unscaled:Math.abs(m.a-1)<.001&&Math.abs(m.d-1)<.001&&Math.abs(m.b)<.001&&Math.abs(m.c)<.001};}),
        markers:[...document.querySelectorAll('.glass-layout-pixel-probe')].map(e=>{const r=e.getBoundingClientRect(),p=e.closest('#sidebar,#chat').getBoundingClientRect();return {y:r.y,height:r.height,visibleWidth:e.checkVisibility()?Math.max(0,Math.min(r.right,p.right)-Math.max(r.left,p.left)):0};})
      };
    };
    window.__markerBaselineY=[...document.querySelectorAll('.glass-layout-pixel-probe')].map(e=>e.getBoundingClientRect().y);
  })()`);
  await until(`document.querySelector('#messages').scrollHeight>document.querySelector('#messages').clientHeight`, 'long conversation');
  await until(`document.documentElement.dataset.theme==='${theme === 'glass' ? 'light' : theme}' && ${theme === 'glass' ? "document.documentElement.dataset.surface==='glass'" : "document.documentElement.dataset.surface!=='glass'"}`, `${theme} theme active`);
  if (theme === 'glass') await until(`getComputedStyle(document.querySelector('#chat')).backdropFilter.includes('url(')`, 'active glass optics');
  assert.equal(await evaluate(`document.querySelectorAll('#pvBody iframe,#pvBody webview').length`), 0, 'Reproduce the empty preview state');
  assert.equal(await evaluate(`document.body.classList.contains('preview-collapsed')`), true, 'Preview is collapsed by default');
  await clickToggle('preview');
  await until(`!document.body.classList.contains('preview-collapsed') && !document.documentElement.classList.contains('layout-motion') && !document.querySelector('.device-switch-mask')`, 'Open empty preview for motion regression');
  await sleep(300);
  await evaluate(`(() => {
    window.__forbiddenTransitions=[];
    const forbid=function(){__forbiddenTransitions.push(performance.now());throw Error('Pane folding attempted a forbidden View Transition');};
    document.startViewTransition=forbid;
    Element.prototype.startViewTransition=forbid;
    document.documentElement.startViewTransition=forbid;
    document.querySelector('#layout').startViewTransition=forbid;
  })()`);
  // Each screenshot gets a fresh animation so capture cannot exhaust the motion watchdog.
  for (const name of skipPixels ? [] : ['sidebar', 'preview', 'focus']) for (const time of [0, 16, 110, 279]) for (const collapsed of [true, false]) {
    const direction = `${name}-${action(name, collapsed)}`;
    await clickToggle(name);
    await until(`document.querySelector('#layout').getAnimations().some(a=>!a.effect?.pseudoElement&&a.playState==='running'&&a.effect.getKeyframes().some(k=>k.gridTemplateColumns))`, 'live grid animation starts');
    const state = await evaluate(`(() => {
      window.__glassLayoutAnimations=document.querySelector('#layout').getAnimations().filter(a=>!a.effect?.pseudoElement&&a.effect.getKeyframes().some(k=>k.gridTemplateColumns));
      for(const a of __glassLayoutAnimations){a.pause();a.currentTime=${time};}
      return __glassLayoutState();
    })()`);
    assert.ok(state.active && state.live, `${direction}/${time}: actual live transition remains active`);
    assert.equal(state[`${name}Collapsed`], collapsed);
    assertLiveState(state, `${direction}/${time}`);
    if (theme === 'glass') assert.ok(state.sources.every(item => !item.filter.includes('url(')), `${direction}/${time}: resizing panes use stable frost`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(output, `${direction}-${String(time).padStart(3, '0')}ms.png`);
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    const painted = await pixels(shot.result.data);
    for (const [index, marker] of painted.entries()) {
      // The sidebar's fixed-width contents are progressively clipped, never stretched.
      if (index === 0 && state.markers[index].visibleWidth < 4) continue;
      assert.ok(marker.count >= 30, `${direction}/${time}: footer marker ${index} must remain visible: ${JSON.stringify(marker)}`);
      assert.ok(marker.height >= 10 && marker.height <= 14, `${direction}/${time}: footer marker ${index} stretched in screenshot: ${JSON.stringify(marker)}`);
      assert.ok(Math.abs(marker.y - state.markers[index].y) <= 2, `${direction}/${time}: footer marker ${index} moved vertically: ${JSON.stringify({painted:marker,expected:state.markers[index]})}`);
    }
    samples.push({ direction, time, file, ...state, painted });
    await evaluate(`for(const a of __glassLayoutAnimations)a.play()`);
    await settled(name, collapsed);
    console.log(`PASS ${theme} ${direction} ${time}ms: footer pixels keep their height`);
  }
  // Unlike paused samples, these include every actual first/last handoff frame.
  for (const name of ['sidebar', 'preview', 'focus']) for (const collapsed of [true, false]) {
    await recordContinuous(name, collapsed, `empty ${name} ${action(name, collapsed)}`);
  }
  for (const name of ['sidebar', 'preview']) {
    await clickToggle(name);
    await until(`document.documentElement.classList.contains('layout-motion-live')`, `${name} rapid sequence starts`);
    await evaluate(`document.querySelector('${controls[name].selector}').click();document.querySelector('${controls[name].selector}').click();`);
    await settled(name, true);
    await clickToggle(name);
    await settled(name, false);
  }

  // A real HTML preview must retain its browsing context and settle at the final viewport.
  writeFileSync(path.join(workspace, 'glass-motion.html'), `<!doctype html><style>body{margin:0;background:#17242e;color:white;font:18px system-ui}p{padding:20px}</style><p>Glass layout preview</p><script>const id=Math.random();let frames=0,resizes=0;addEventListener('resize',()=>resizes++);function tick(){frames++;requestAnimationFrame(tick)}tick();addEventListener('message',e=>{if(e.data==='glass-preview-probe')parent.postMessage({type:'glass-preview-probe',id,frames,resizes,width:innerWidth,height:innerHeight},'*')});</script>`);
  await evaluate(`addEventListener('message',e=>{if(e.data?.type==='glass-preview-probe')window.__guestMotion=e.data});document.querySelector('#treeRefresh').click();`);
  await until(`[...document.querySelectorAll('#wsTree .fname')].some(e=>e.textContent==='glass-motion.html')`, 'HTML fixture in file tree');
  await evaluate(`[...document.querySelectorAll('#wsTree .fname')].find(e=>e.textContent==='glass-motion.html').closest('.trow').click()`);
  await until(`!!document.querySelector('#pvBody iframe')`, 'HTML preview opens');
  async function guest() {
    await evaluate(`window.__guestMotion=null;document.querySelector('#pvBody iframe').contentWindow.postMessage('glass-preview-probe','*')`);
    await until('!!window.__guestMotion', 'HTML preview probe');
    return evaluate('__guestMotion');
  }
  await sleep(300);
  const initialGuest = await guest();
  const resizeCounts = [];
  for (const name of ['sidebar', 'preview', 'focus']) for (const collapsed of [true, false]) {
    const beforeGuest = await guest();
    const initialRect = await evaluate(`(()=>{const r=document.querySelector('#pvBody iframe').getBoundingClientRect();return {width:r.width,height:r.height}})()`);
    await recordContinuous(name, collapsed, `HTML ${name} ${action(name, collapsed)}`);
    const afterGuest = await guest();
    const measurement = { name, collapsed, resizes: afterGuest.resizes - beforeGuest.resizes, initialRect, beforeGuest, afterGuest };
    resizeCounts.push(measurement);
    console.log(`HTML viewport resize count: ${JSON.stringify(measurement)}`);
    assert.ok(measurement.resizes <= 2, `HTML ${name} ${action(name, collapsed)} must resize only at settled viewport, not every animation frame: ${JSON.stringify(measurement)}`);
  }
  const finalGuest = await guest();
  assert.equal(finalGuest.id, initialGuest.id, 'Folding must preserve the HTML preview instance');
  const viewport = await evaluate(`(()=>{const e=document.querySelector('#pvBody iframe'),r=e.getBoundingClientRect();return {width:r.width,height:r.height,style:e.getAttribute('style')}})()`);
  assert.ok(Math.abs(finalGuest.width - viewport.width) <= 1 && Math.abs(finalGuest.height - viewport.height) <= 1, 'Guest viewport equals the final rendered frame');
  assert.ok(!viewport.style?.includes('important'), 'Held guest viewport styles must be restored');

  await clickToggle('sidebar');
  await until(`document.documentElement.classList.contains('layout-motion-live')`, 'resize interruption starts');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await settled('sidebar', true);
  assert.equal((await guest()).id, initialGuest.id, 'Window resize preserves the preview instance');
  await clickToggle('sidebar');
  await settled('sidebar', false);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (const name of ['sidebar', 'preview', 'focus']) for (const collapsed of [true, false]) {
    await clickToggle(name);
    await settled(name, collapsed);
    assert.equal(await evaluate(`document.querySelector('#layout').getAnimations().length`), 0, 'Reduced motion creates no pane animation');
  }
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  writeFileSync(path.join(output, skipPixels ? 'report-continuity.json' : 'report.json'), JSON.stringify({ theme, fixture, samples, continuous, preview: { initialGuest, finalGuest, viewport, resizeCounts }, rapidToggle: 'passed', resize: 'passed', reducedMotion: 'passed' }, null, 2));
  console.log(`PASS ${theme} layout: ${samples.length} compositor frames, ${continuous.length} uninterrupted folds, rapid toggles, preview continuity, resize and reduced motion; ${output}`);
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
  ws?.close();
  electron.kill();
}
