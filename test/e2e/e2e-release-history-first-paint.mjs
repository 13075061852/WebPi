// Offline renderer regression: delayed history readiness, stable repeated
// opening and reading-position preservation. No accounts or remote requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packaged = Boolean(process.env.HALO_PACKAGED_EXE);
const executable = path.resolve(process.env.HALO_PACKAGED_EXE || path.join(root, 'node_modules/electron/dist/electron.exe'));
assert.ok(fs.existsSync(executable), 'Install Electron or provide HALO_PACKAGED_EXE');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-history-paint-'));
const profile = path.join(fixture, 'profile'), agent = path.join(fixture, 'agent'), workspace = path.join(fixture, 'workspace');
for (const directory of [profile, agent, workspace]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
const system = process.env.SystemRoot || 'C:/Windows';
const env = {
  SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: agent, PI_HALO_PI_PATH: path.join(root, 'test/fixtures/pi-sdk.js'), PI_OFFLINE: '1',
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, ws, output = '', exited, sequence = 0;
const pending = new Map();
const started = Date.now();
async function waitFor(fn, message, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    if (exited !== undefined) throw Error(`App exited before ${message} (code ${exited})`);
    await sleep(50);
  }
  throw Error(message);
}
async function command(method, params = {}) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timed out: ${method}`)); }, 12000);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  assert.equal(response.error, undefined, 'CDP request failed');
  return response.result;
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert.equal(response?.exceptionDetails, undefined, JSON.stringify(response?.exceptionDetails));
  return response?.result?.value;
}
try {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  child = spawn(executable, [...(packaged ? [] : [root]), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
    { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-5000); });
  child.on('error', error => { output = error.message; });
  child.on('exit', code => { exited = code; });
  const page = await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) })).json();
      return pages.find(item => item.type === 'page' && item.url.endsWith('index.html'));
    } catch { return null; }
  }, 'Main renderer did not load');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), request = pending.get(response.id);
    if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response); }
  });
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(result => result.data)'))?.ready, 'Fixture startup did not complete');
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await command('Page.bringToFront');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(() => evaluate('!document.hidden'), 'Renderer must be visible for actual paint sampling');
  const initialized = await evaluate(`(async () => {
    const { initReleaseHistory } = await import('./js/release-history.mjs');
    const source = document.querySelector('#settingsModal');
    const modal = source.cloneNode(true); source.remove(); document.body.appendChild(modal);
    modal.hidden = false; modal.classList.add('show');
    modal.querySelectorAll('.set-pane').forEach(node => node.classList.toggle('active', node.id === 'setPane-history'));
    modal.querySelectorAll('.set-nav').forEach(node => node.classList.toggle('active', node.dataset.pane === 'history'));
    const list = modal.querySelector('#releaseHistoryList'), nav = modal.querySelector('#releaseHistoryNav');
    list.replaceChildren(); nav.replaceChildren();
    const body = Array.from({length: 22}, (_, index) => 'Reading paragraph ' + index + ': stable history content and enough height for real scrolling.').join('\\n\\n');
    const data = [{ version: '2.0.0', date: '2030-01-01T00:00:00Z', body }];
    for (let index = 0; index < 8; index++) data.push({version: '1.' + (50-index) + '.0', date: '2029-01-' + String(20-index).padStart(2,'0') + 'T00:00:00Z', body});
    const state = window.__historyPaint = { modal, list, nav, data, calls: [], frames: [], running: true, mutations: 0 };
    let resolveInitial;
    const initial = new Promise(resolve => { resolveInitial = resolve; });
    let delayed = true;
    const api = {
      releaseHistory(force) { state.calls.push(force); return delayed ? initial : Promise.resolve({ok:true,data:state.data}); },
      appUpdateState() { return Promise.resolve({ok:true,data:{currentVersion:'2.0.0'}}); },
      openExternal() { return Promise.resolve({ok:true}); }
    };
    state.releaseInitial = () => { delayed = false; resolveInitial({ok:true,data:state.data}); };
    state.controller = initReleaseHistory({root:modal,api});
    const sample = () => {
      state.frames.push({list:list.hidden ? null : list.firstElementChild?.dataset.version || null,
        nav:nav.hidden ? null : nav.firstElementChild?.dataset.version || null});
      if(state.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return {calls:state.calls.length,first:list.firstElementChild?.dataset.version || null};
  })()`);
  assert.equal(initialized.calls, 1, 'History must preload when its controller initializes');
  assert.equal(initialized.first, null, 'Bundled notes must not render before the initial request settles');
  await sleep(380);
  const loading = await evaluate(`(() => {
    const state=__historyPaint, loading=state.modal.querySelector('#releaseHistoryLoading');
    const layout=state.modal.querySelector('.release-history-layout').getBoundingClientRect();
    const spinner=loading?.querySelector('.pkg-loading-spinner');
    const spans=loading ? [...loading.querySelectorAll('span')].map(node=>node.getBoundingClientRect()) : [];
    const left=Math.min(...spans.map(rect=>rect.left)),right=Math.max(...spans.map(rect=>rect.right));
    const top=Math.min(...spans.map(rect=>rect.top)),bottom=Math.max(...spans.map(rect=>rect.bottom));
    const style=spinner && getComputedStyle(spinner);
    return {frames:state.frames,hasLoading:!!loading,visible:!!loading&&!loading.hidden&&getComputedStyle(loading).display!=='none',
      text:loading?.textContent.trim(),centerX:Math.abs((left+right)/2-(layout.left+layout.right)/2),
      centerY:Math.abs((top+bottom)/2-(layout.top+layout.bottom)/2), animation:style?.animationName,
      duration:parseFloat(style?.animationDuration),running:spinner?.getAnimations().some(animation=>animation.playState==='running'),
      listHidden:state.list.hidden,navHidden:state.nav.hidden};
  })()`);
  assert.ok(loading.frames.length >= 6, 'The delayed response must span multiple actual renderer frames');
  assert.ok(loading.frames.every(frame => frame.list === null && frame.nav === null), 'No stale bundled version may flash while loading');
  assert.equal(loading.hasLoading, true);
  assert.equal(loading.visible, true);
  assert.equal(loading.listHidden, true);
  assert.equal(loading.navHidden, true);
  assert.match(loading.text, /^加载中(?:…|\.\.\.)?$/);
  assert.ok(loading.centerX < 3 && loading.centerY < 3, 'The loading icon and label must be centered in the history area');
  assert.notEqual(loading.animation, 'none');
  assert.ok(loading.duration > 0 && loading.running, 'The loading spinner must have an active animation');
  await evaluate('__historyPaint.releaseInitial();__historyPaint.controller.refresh()');
  await sleep(120);
  const firstPaint = await evaluate(`(() => {
    const state=__historyPaint;
    state.firstList=state.list.firstElementChild;state.firstNav=state.nav.firstElementChild;
    state.observer=new MutationObserver(records=>{state.mutations+=records.filter(record=>record.type==='childList').length;});
    state.observer.observe(state.list,{childList:true});state.observer.observe(state.nav,{childList:true});
    return {frames:state.frames.filter(frame=>frame.list||frame.nav),first:state.firstList?.dataset.version,
      nav:state.firstNav?.dataset.version,loadingHidden:state.modal.querySelector('#releaseHistoryLoading').hidden};
  })()`);
  assert.equal(firstPaint.first, '2.0.0');
  assert.equal(firstPaint.nav, '2.0.0');
  assert.equal(firstPaint.loadingHidden, true);
  assert.ok(firstPaint.frames.length > 0 && firstPaint.frames[0].list === '2.0.0' && firstPaint.frames[0].nav === '2.0.0',
    'The first visible version must be the newest response rather than bundled notes');
  const repeated = await evaluate(`(async () => {
    const state=__historyPaint;
    for(let index=0;index<3;index++) {state.modal.hidden=true;await new Promise(resolve=>requestAnimationFrame(resolve));state.modal.hidden=false;state.modal.querySelector('[data-pane=history]').click();await state.controller.refresh();}
    await state.controller.refresh(true);await new Promise(resolve=>requestAnimationFrame(resolve));
    return {sameList:state.list.firstElementChild===state.firstList,sameNav:state.nav.firstElementChild===state.firstNav,mutations:state.mutations};
  })()`);
  assert.deepEqual(repeated, { sameList: true, sameNav: true, mutations: 0 }, 'Repeated openings and unchanged refreshes must retain DOM nodes');
  const anchored = await evaluate(`(async () => {
    const state=__historyPaint,entry=state.list.querySelector('[data-version="1.48.0"]');
    state.list.scrollTop+=entry.getBoundingClientRect().top-state.list.getBoundingClientRect().top+80;
    state.nav.scrollTop=90;
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const before=entry.getBoundingClientRect().top-state.list.getBoundingClientRect().top,navBefore=state.nav.scrollTop;
    state.data=[{version:'2.1.0',date:'2031-01-01T00:00:00Z',body:state.data[0].body},...state.data];
    await state.controller.refresh(true);await new Promise(resolve=>requestAnimationFrame(resolve));
    const after=state.list.querySelector('[data-version="1.48.0"]').getBoundingClientRect().top-state.list.getBoundingClientRect().top;
    return {before,after,navBefore,navAfter:state.nav.scrollTop,latest:state.list.firstElementChild.dataset.version,
      mutations:state.mutations,forceCalls:state.calls.filter(force=>force===true).length};
  })()`);
  assert.equal(anchored.latest, '2.1.0');
  assert.ok(anchored.mutations > 0, 'Changed history must update its content');
  assert.ok(anchored.navBefore > 0, 'Fixture must actually scroll the navigation');
  assert.ok(Math.abs(anchored.after - anchored.before) < 2, `A new version must preserve the existing reading position: ${JSON.stringify(anchored)}`);
  assert.ok(Math.abs(anchored.navAfter - anchored.navBefore) < 2, 'Refreshing must preserve navigation scroll');
  assert.ok(anchored.forceCalls >= 2, 'Manual refresh must request fresh history');
  await evaluate('__historyPaint.running=false;__historyPaint.observer.disconnect();setTimeout(()=>window.halo.close(),30);true');
  await waitFor(() => exited !== undefined, 'App did not close', 15000); assert.equal(exited, 0);
  const report = { passed: true, packaged, loadingFrames: loading.frames.length,
    loadingCenter: { x: loading.centerX, y: loading.centerY }, firstVersion: firstPaint.first,
    unchangedDom: repeated, readingAnchor: anchored, exitCode: exited, elapsedMs: Date.now() - started };
  fs.mkdirSync(path.join(root, 'test/results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/results/release-history-first-paint.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS history first paint: ${loading.frames.length} loading frames, newest first, unchanged DOM, reading anchor ${Math.abs(anchored.after-anchored.before).toFixed(1)}px, clean close`);
} catch (error) {
  fs.mkdirSync(path.join(root, 'test/results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/results/release-history-first-paint-failure.log'), error.message + '\n' + output);
  throw error;
} finally {
  ws?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await Promise.race([closed, sleep(5000)]); }
  const target = path.resolve(fixture);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('halo-history-paint-'));
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
