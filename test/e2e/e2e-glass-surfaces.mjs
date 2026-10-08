/** Real app glass coverage. Isolated account/profile; screenshots never inject visual fixtures. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const fixture = mkdtempSync(path.join(tmpdir(), 'halo-glass-surfaces-'));
const profile = path.join(fixture, 'profile');
const workspace = path.join(fixture, 'workspace');
const agent = path.join(fixture, 'agent');
for (const dir of [profile, workspace, agent, path.join(profile, 'theme-images')]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }] }));
writeFileSync(path.join(fixture, 'npmrc'), '');
// Use the existing production cache with the actual local theme assets, keeping thumbnail reads offline.
const manifest = JSON.parse(readFileSync('assets/theme-images.json', 'utf8'));
for (const [key, entry] of Object.entries(manifest)) {
  const source = path.join('assets', key);
  if (existsSync(source)) copyFileSync(source, path.join(profile, 'theme-images', createHash('sha256').update(entry.url).digest('hex')));
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE)/i.test(key)));
Object.assign(env, {
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  XDG_CONFIG_HOME: path.join(fixture, 'config'), GH_CONFIG_DIR: path.join(fixture, 'gh'),
  // This app uses Git Credential Manager, whose default Windows store ignores HOME/GH_CONFIG_DIR.
  GCM_CREDENTIAL_STORE: 'plaintext', GCM_PLAINTEXT_STORE_PATH: path.join(fixture, 'empty-gcm-store'),
  NPM_CONFIG_USERCONFIG: path.join(fixture, 'npmrc'), PI_CODING_AGENT_DIR: agent,
  PI_HALO_PI_PATH: path.resolve('test/fixtures/pi-sdk.js'), PI_OFFLINE: '1',
});
const electron = spawn(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron',
  ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
electron.stdout.on('data', () => {});
electron.stderr.on('data', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, serial = 0;
const pending = new Map(), exceptions = [], coverage = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails) throw new Error(JSON.stringify(response.result.exceptionDetails));
  return response.result?.result?.value;
}
async function waitFor(expression, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(80);
  }
  throw new Error(`Timed out: ${label}`);
}
async function click(selector) {
  await waitFor(`(() => {const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`, `visible ${selector}`);
  const point = await evaluate(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest',inline:'nearest'});
    const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
    if(hit!==e&&!e.contains(hit))throw Error('Click obstructed: '+${JSON.stringify(selector)});
    return {x,y};
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function type(selector, text) {
  await click(selector);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.insertText', { text });
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), text, `Typing into ${selector}`);
}
async function capture(name) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720, y: 5 });
  await sleep(200);
  const result = await send('Page.captureScreenshot', { format: 'png' });
  const file = `test/shot-glass-app-${name}.png`;
  writeFileSync(file, Buffer.from(result.result.data, 'base64'));
  console.log('Saved', file);
}
async function checkModal(id, origin = 'app action') {
  await waitFor(`(() => {const p=document.querySelector('#${id} .modal-panel');return p?.getBoundingClientRect().width>0&&p.classList.contains('glass-lens')&&getComputedStyle(p).backdropFilter.includes('url(');})()`, `${id} glass lens`);
  const state = await evaluate(`(() => {
    const p=document.querySelector('#${id} .modal-panel'),s=getComputedStyle(p);
    const alpha=color=>{const values=color.match(/[\\d.]+/g)?.map(Number)||[];return values.length===4?values[3]:1;};
    const gradientAlpha=[...s.backgroundImage.matchAll(/rgba?\\([^)]+\\)/g)].map(m=>alpha(m[0]));
    return {surface:p.classList.contains('glass-surface'),background:s.backgroundColor,image:s.backgroundImage,
      backgroundAlpha:alpha(s.backgroundColor),gradientAlpha,filter:s.backdropFilter,
      visiblePanels:[...document.querySelectorAll('.modal-panel')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({id:e.closest('.modal')?.id,surface:e.classList.contains('glass-surface'),lens:e.classList.contains('glass-lens')}))};
  })()`);
  assert.ok(state.surface, `${id} missing shared material`);
  assert.ok(state.backgroundAlpha < .8 && state.gradientAlpha.every(alpha => alpha < .8), `${id} has opaque fill: ${JSON.stringify(state)}`);
  assert.ok(state.visiblePanels.every(panel => panel.surface && panel.lens), `Visible dialog lacks material: ${JSON.stringify(state.visiblePanels)}`);
  coverage.push({ id, origin, ...state });
}
async function closeModal(id) {
  await click(`#${id} .modal-x[data-close]`);
  await waitFor(`document.querySelector('#${id}').hidden`, `${id} closes`);
}
async function selectPane(pane) {
  await click(`#settingsModal .set-nav[data-pane="${pane}"]`);
  await waitFor(`document.querySelector('#setPane-${pane}').classList.contains('active')&&document.querySelectorAll('#settingsModal .set-pane.active').length===1`, `${pane} activates`);
  await checkModal('settingsModal', `settings tab: ${pane}`);
}

try {
  let main;
  for (let attempt = 0; attempt < 60 && !main; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      main = targets.find(target => target.type === 'page' && target.url.endsWith('index.html'));
    } catch {}
    if (!main) await sleep(250);
  }
  assert.ok(main, 'Main Electron page');
  ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message);
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor('!!window.__haloDispatch', 'Renderer ready', 20000);
  const githubState = await evaluate('window.halo.githubStatus()');
  assert.deepEqual(githubState?.data?.accounts, [], 'Test must not see the Windows personal GitHub credential store');
  // Pick the installed section through its handler before opening settings; do not fetch the public marketplace.
  await evaluate(`document.querySelector('#pkgTabs [data-t="installed"]').click()`);
  await click('#btnSettings');
  await click('#settingsModal .set-nav[data-pane="appearance"]');
  await click('[data-theme-choice="glass"]');
  await checkModal('settingsModal', 'appearance theme selection');
  await closeModal('settingsModal');
  await capture('home');
  await click('#btnSettings');

  const panes = await evaluate(`[...document.querySelectorAll('#settingsModal .set-nav')].map(e=>e.dataset.pane)`);
  for (const pane of panes) {
    await selectPane(pane);
    if (pane === 'appearance') {
      await waitFor(`[...document.querySelectorAll('#theme-panel-nature .wallpaper-sample')].every(e=>e.dataset.previewState==='ready')`, 'Cached production theme thumbnails');
      await click('#theme-tab-city');
      assert.equal(await evaluate(`document.querySelector('#theme-tab-city').getAttribute('aria-selected')`), 'true');
      await click('#theme-tab-nature');
    }
    if (pane === 'proxy') {
      const original = await evaluate(`document.querySelector('#proxyPort').value`);
      await type('#proxyPort', '7891');
      await type('#proxyPort', original);
      await click('#connectivityDomesticTab');
      assert.equal(await evaluate(`document.querySelector('#connectivityDomesticTab').getAttribute('aria-selected')`), 'true');
      await click('#connectivityForeignTab');
      assert.ok(await evaluate(`document.querySelector('#proxyPort').classList.contains('glass-surface')`), 'Proxy input shared material');
    }
    if (pane === 'digital-human') {
      await waitFor(`!document.querySelector('#digitalHumanProfileFields').hidden`, 'Digital human profile loads');
      assert.ok(await evaluate(`document.querySelector('#digitalHumanVoice').classList.contains('glass-surface')`), 'Voice selector shared material');
    }
    await sleep(350);
    await capture(`settings-${pane}`);
  }
  await closeModal('settingsModal');
  await click('#btnDigitalHuman');
  await waitFor(`!document.querySelector('#digitalHumanFields').hidden`, 'Digital human draft loads');
  await checkModal('digitalHumanModal');
  await type('#digitalHumanScript', '你好，欢迎来到我的工作室。今天我们一起介绍这款产品。');
  await type('#digitalHumanScene', '明亮的工作室，站在产品展示台旁。');
  assert.ok(await evaluate(`document.querySelector('#digitalHumanScript').classList.contains('glass-surface')`), 'Script field shared material');
  await capture('digital-human');
  await click('#digitalHumanSave');
  await closeModal('digitalHumanModal');

  for (const [id, button] of [['modelModal', '#btnModel'], ['thinkModal', '#btnThink'], ['authModal', '#authBtn'], ['usageDetailModal', '#ctxQuota']]) {
    await click(button);
    await checkModal(id);
    if (id === 'modelModal') await type('#modelSearch', 'a');
    await capture(id.replace('Modal', '').replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()));
    await closeModal(id);
  }
  await click('#sideNav [data-tab="skills"]');
  await click('#serverAdd');
  await checkModal('serverModal');
  await capture('server');
  await closeModal('serverModal');
  await click('#sideNav [data-tab="chat"]');

  // Structural coverage only for dialogs whose real opening path requires conversation/log/account data.
  // No synthetic content or screenshot fixture is inserted, and these states are not used for screenshots.
  const covered = new Set(coverage.map(row => row.id));
  const dialogs = await evaluate(`[...document.querySelectorAll('.modal')].filter(e=>e.querySelector('.modal-panel')).map(e=>e.id)`);
  for (const id of dialogs.filter(id => !covered.has(id))) {
    await evaluate(`(() => {const m=document.getElementById(${JSON.stringify(id)});m.hidden=false;m.classList.add('show');})()`);
    await checkModal(id, 'structural visibility only');
    await closeModal(id);
  }

  await click('#btnSettings');
  await selectPane('appearance');
  for (const theme of ['light', 'dark']) {
    await click(`[data-theme-choice="${theme}"]`);
    await waitFor(`!document.documentElement.dataset.surface&&!document.querySelector('.glass-lens,.glass-surface,.glass-filter-defs filter')`, `${theme} cleans glass material`);
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), theme);
    assert.equal(await evaluate(`document.querySelectorAll('[style*="--glass-refraction"]').length`), 0, 'No dangling filter references');
    await capture(theme);
    if (theme === 'light') {
      await click('[data-theme-choice="glass"]');
      await checkModal('settingsModal', 'glass reactivation');
    }
  }
  await closeModal('settingsModal');
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  mkdirSync('test/results', { recursive: true });
  writeFileSync('test/results/glass-surfaces.json', JSON.stringify({ fixture, settingsPanes: panes, coverage }, null, 2));
  console.log(`PASS real app glass: ${panes.length} settings tabs, ${new Set(coverage.map(row => row.id)).size} dialogs, typing/clicks/cleanup`);
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
  ws?.close();
  electron.kill();
}
