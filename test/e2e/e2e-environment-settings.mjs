// Read-only detection through the real preload/main process, then renderer fixtures
// for installer states. Never invoke the real environmentInstall API in this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const packaged = process.argv.includes('--packaged');
const exe = path.resolve(packaged ? 'dist/win-unpacked/Pi Halo.exe' : 'node_modules/electron/dist/electron.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-environment-ui-'));
const userData = path.join(dir, 'profile'), workspace = path.join(dir, 'workspace'), agent = path.join(dir, 'agent');
for (const folder of [userData, workspace, agent]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(userData, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
fs.mkdirSync('test/results', { recursive: true });
let child, ws, output = '';
const website = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('X-Frame-Options', 'DENY');
  res.end(`<title>Website preview ${req.url}</title><h1>Deployed website</h1><a href="/next">Next page</a>`);
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  website.listen(0, '127.0.0.1'); await once(website, 'listening');
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'roaming'),
    PI_CODING_AGENT_DIR: agent, PI_HALO_PI_PATH: path.resolve('test/fixtures/pi-sdk.js'), PI_OFFLINE: '1' };
  // LOCALAPPDATA is retained only for read-only discovery of WinGet's execution alias.
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, [...(packaged ? [] : ['.']), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', text => { output = (output + text).slice(-6000); });
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page' && p.url.endsWith('index.html')); } catch {}
    if (!page) await sleep(250);
  }
  assert.ok(page, `App did not start: ${output}`);
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  let id = 0; const pending = new Map();
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data), request = pending.get(data.id);
    if (request) { pending.delete(data.id); request(data); }
  });
  async function command(method, params = {}) {
    const response = await new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timeout: ${method}`)); }, 25000);
      pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  }
  async function evaluate(expression) {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response));
    return response.result?.value;
  }
  async function until(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await sleep(150);
    }
    assert.fail(`UI did not settle: ${expression}`);
  }
  async function screenshot(name) {
    await sleep(400); // Let the existing theme/color transitions settle.
    const result = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`test/results/environment-${name}${packaged ? '-packaged' : ''}.png`, Buffer.from(result.data, 'base64'));
  }
  await until('window.halo && document.querySelectorAll(".environment-tool").length === 3');
  const siteURL = `http://127.0.0.1:${website.address().port}/`;
  await evaluate(`(async () => {
    const {renderWebsiteCards} = await import('./js/website-preview.mjs');
    const turn = document.createElement('div'); turn.id = 'websiteFixture'; turn.__websiteURLs = new Set([${JSON.stringify(siteURL)}]);
    document.body.append(turn);
    const reply = document.createElement('div'); reply.className = 'md';
    const paragraph = document.createElement('p'), duplicate = document.createElement('a');
    duplicate.href = ${JSON.stringify(siteURL)}; duplicate.textContent = '打开网站'; paragraph.append(duplicate);
    const unrelated = document.createElement('a'); unrelated.href = 'https://example.com/docs'; unrelated.textContent = '文档';
    reply.append(paragraph, unrelated); turn.append(reply);
    renderWebsiteCards(turn, url => {
      const md = document.createElement('div'); md.className = 'md';
      const a = document.createElement('a'); a.href = url; md.append(a); document.body.append(md); a.click(); md.remove();
    });
    turn.querySelector('.website-open').click();
  })()`);
  await until(`document.querySelector('#pvName').textContent === 'Website preview /'`);
  await until(`document.querySelector('.website-load').hidden && !document.querySelector('#pvBody webview').isLoading()`);
  assert.equal(await evaluate(`document.querySelector('.website-open span').textContent`), siteURL);
  assert.equal(await evaluate(`document.querySelectorAll('#websiteFixture .md a').length`), 1);
  assert.equal(await evaluate(`document.querySelector('#websiteFixture .md a').textContent`), '文档');
  assert.equal(await evaluate(`document.querySelectorAll('#websiteFixture .md p').length`), 0);
  const isolation = await evaluate(`document.querySelector('#pvBody webview').executeJavaScript('({node:typeof require,bridge:typeof window.halo})')`);
  assert.deepEqual(isolation, {node:'undefined', bridge:'undefined'});
  await evaluate(`document.querySelector('#pvBody webview').executeJavaScript('document.querySelector("a").click()', true)`);
  await until(`document.querySelector('.website-toolbar input').value.endsWith('/next')`);
  await until(`document.querySelector('.website-load').hidden`);
  assert.equal(await evaluate(`document.querySelector('[data-nav=back], [data-nav=forward]') === null`), true);
  const initialViewport = await evaluate(`document.querySelector('#pvBody webview').executeJavaScript('window.innerWidth')`);
  await evaluate(`for (let i=0;i<6;i++) document.querySelector('[data-zoom=in]').click()`);
  await until(`document.querySelector('#pvBody webview').executeJavaScript('window.innerWidth').then(width => Math.abs(width * 2 - ${initialViewport}) < 3)`);
  assert.equal(await evaluate(`document.querySelector('[data-zoom=reset]').textContent`), '200%');
  await evaluate(`document.querySelector('[data-zoom=reset]').click()`);
  await until(`document.querySelector('#pvBody webview').executeJavaScript('window.innerWidth').then(width => Math.abs(width - ${initialViewport}) < 2)`);
  await evaluate(`document.querySelector('[data-zoom=in]').click()`);
  assert.equal(await evaluate(`document.querySelector('#pvBody webview').getZoomFactor()`), 1.1);
  await until(`document.querySelector('#pvBody webview').executeJavaScript('window.innerWidth').then(width => Math.abs(width * 1.1 - ${initialViewport}) < 3)`);
  await evaluate(`document.querySelector('[data-zoom=out]').click(); document.querySelector('[data-zoom=out]').click()`);
  assert.equal(await evaluate(`document.querySelector('#pvBody webview').getZoomFactor()`), 0.9);
  const refreshLayout = await evaluate(`(() => {
    const guest = document.querySelector('#pvBody webview'), before = guest.getBoundingClientRect();
    const button = document.querySelector('[data-nav=reload]'); button.click();
    const after = guest.getBoundingClientRect();
    return {busy:button.getAttribute('aria-busy'), hidden:document.querySelector('.website-load').hidden, stable:before.y === after.y && before.height === after.height};
  })()`);
  assert.deepEqual(refreshLayout, {busy:'true', hidden:true, stable:true});
  await until(`document.querySelector('.website-load').hidden && !document.querySelector('#pvBody webview').isLoading()`);
  await until(`document.querySelector('[data-nav=reload]').getAttribute('aria-busy') === 'false'`);
  assert.equal(await evaluate(`document.querySelector('#pvBody webview').getZoomFactor()`), 0.9);
  await evaluate(`document.querySelector('[data-zoom=reset]').click()`);
  assert.equal(await evaluate(`document.querySelector('#pvBody webview').getZoomFactor()`), 1);
  await evaluate(`document.querySelector('#pvBody webview').focus()`);
  const wheelViewport = await evaluate(`document.querySelector('#pvBody webview').executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.innerWidth))))')`);
  await evaluate(`document.querySelector('#pvBody webview').executeJavaScript('window.dispatchEvent(new WheelEvent("wheel", {ctrlKey:true, deltaY:-120, cancelable:true}))')`);
  await until(`document.querySelector('[data-zoom=reset]').textContent === '110%'`);
  assert.equal(await evaluate(`document.querySelector('#pvBody webview').getZoomFactor()`), 1.1);
  await until(`document.querySelector('#pvBody webview').executeJavaScript('window.innerWidth').then(width => Math.abs(width * 1.1 - ${wheelViewport}) < 3)`);
  await evaluate(`document.querySelector('#pvBody webview').executeJavaScript('window.dispatchEvent(new WheelEvent("wheel", {ctrlKey:true, deltaY:120, cancelable:true}))')`);
  await until(`document.querySelector('[data-zoom=reset]').textContent === '100%'`);
  assert.ok(await evaluate(`document.querySelector('#pvBody webview').getBoundingClientRect().height > 100`));
  await screenshot('website-browser');
  for (const device of ['tablet', 'mobile', 'desktop']) {
    await evaluate(`document.querySelector('.pvdev[data-dev="${device}"]').click()`);
    await sleep(650);
    const frame = await evaluate(`(() => {
      const shell = document.querySelector('#pvBody .dev-shell'), guest = shell.querySelector('webview');
      const s = shell.getBoundingClientRect(), g = guest.getBoundingClientRect();
      return {framed:g.x > s.x && g.y > s.y && g.width < s.width, height:g.height, toolbar:document.querySelector('.website-toolbar').getBoundingClientRect().bottom <= s.top};
    })()`);
    assert.ok(frame.framed && frame.toolbar && frame.height > 100, JSON.stringify(frame));
    await screenshot('website-' + device);
  }
  await evaluate(`document.querySelector('#websiteFixture').remove()`);
  console.log('PASS website delivery card, embedded browser, frame-denial compatibility, navigation and Node/IPC isolation');
  await evaluate('document.querySelector("#btnSettings").click(); document.querySelector(".set-nav[data-pane=environment]").click()');
  await until('document.querySelector("#setPane-environment").getAttribute("aria-busy") === "false"');
  const real = await evaluate('window.halo.environmentStatus()');
  assert.equal(real.ok, true);
  assert.equal(real.data.tools.length, 3);
  assert.equal(real.data.installing, false);
  const cloudflare = await evaluate('window.halo.cloudflareStatus()');
  assert.equal(cloudflare.ok, true, JSON.stringify(cloudflare));
  assert.equal(typeof cloudflare.data.authorized, 'boolean');
  assert.ok(await evaluate('document.querySelector("#setPane-environment").classList.contains("active")'));
  await evaluate('document.documentElement.dataset.theme = "light"');
  await screenshot('detected');

  // Clone the pane to remove production click handlers, then inject the fake API.
  await evaluate(`(async () => {
    const old = document.querySelector('#setPane-environment');
    const pane = old.cloneNode(true); pane.querySelector('#environmentTools').replaceChildren(); old.replaceWith(pane);
    const state = { platform: 'win32', revision: 100, installing: false, installer: { available: true, name: 'WinGet' }, progress: [],
      tools: ['python', 'node', 'git'].map(id => ({ id, name: id, installed: id === 'node', version: id === 'node' ? '24.20.0' : null,
        path: id === 'node' ? 'C:/Program Files/nodejs/node.exe' : null, problem: id === 'node' ? null : 'missing' })) };
    const fixture = window.envFixture = { state, calls: 0, emit: null, resolve: null, defer: false };
    const api = {
      environmentStatus: async () => ({ ok: true, data: structuredClone(fixture.state) }),
      environmentInstall: () => { fixture.calls++; return new Promise(resolve => { fixture.resolve = resolve; }); },
      onEnvironmentProgress: callback => { fixture.emit = callback; },
      openExternal: async url => { fixture.help = url; return { ok: true }; }
    };
    const { initEnvironmentSettings } = await import(new URL('./js/environment-settings.mjs', location.href).href);
    fixture.controller = initEnvironmentSettings({ api }); await fixture.controller.refresh();
  })()`);
  assert.equal(await evaluate('document.querySelectorAll(".environment-tool[data-state=missing]").length'), 2);
  assert.equal(await evaluate('document.querySelector("#environmentInstall").disabled'), false);
  await screenshot('missing');
  await evaluate('document.querySelector("#environmentInstall").click(); document.querySelector("#environmentInstall").click()');
  assert.equal(await evaluate('envFixture.calls'), 1);
  assert.equal(await evaluate('document.querySelector("#environmentRefresh").disabled'), true);
  // Progress may arrive before the initial IPC response; an older response must not undo it.
  await evaluate(`envFixture.state.revision = 102; envFixture.state.installing = true;
    envFixture.state.progress = [{ id: 'python', state: 'installing', message: '正在全局安装 Python…' }];
    envFixture.emit(structuredClone(envFixture.state));
    envFixture.resolve({ ok: true, data: { ...structuredClone(envFixture.state), revision: 101, installing: false, progress: [] } });`);
  await until('document.querySelector(".environment-tool[data-tool=python]").dataset.state === "busy"');
  assert.equal(await evaluate('document.querySelector("#environmentInstall").textContent'), '正在配置…');
  await evaluate(`envFixture.state.revision = 103; envFixture.state.installing = false;
    envFixture.state.progress.push({ id: 'python', state: 'error', message: '配置失败（测试）：' + 'https://example.test/very-long-download-path/'.repeat(10) });
    envFixture.emit(structuredClone(envFixture.state)); document.documentElement.dataset.theme = 'dark';`);
  assert.equal(await evaluate('document.querySelector("#environmentInstall").disabled'), false);
  assert.equal(await evaluate('document.querySelector(".environment-tool[data-tool=python]").dataset.state'), 'error');
  const overflow = await evaluate(`(() => { const p = document.querySelector('.environment-body'); return p.scrollWidth - p.clientWidth; })()`);
  assert.ok(overflow < 2, `Long installation error must wrap: ${overflow}`);
  await screenshot('failure-dark');
  await evaluate(`envFixture.state.revision = 104; envFixture.state.installer = { available: false, error: '未找到可用的 WinGet', helpUrl: 'https://learn.microsoft.com/windows/package-manager/winget/' };
    envFixture.emit(structuredClone(envFixture.state)); document.querySelector('#environmentHelp').click();`);
  assert.equal(await evaluate('document.querySelector("#environmentInstall").disabled'), true);
  assert.equal(await evaluate('envFixture.help'), 'https://learn.microsoft.com/windows/package-manager/winget/');
  await evaluate(`envFixture.state.revision = 105; envFixture.state.progress = [];
    envFixture.state.tools.forEach(tool => { tool.installed = true; tool.version = '1.2.3'; });
    envFixture.emit(structuredClone(envFixture.state));`);
  assert.equal(await evaluate('document.querySelector("#environmentInstall").textContent'), '环境已就绪');
  assert.equal(await evaluate('document.querySelector("#environmentIssue").hidden'), true);
  console.log(`PASS ${packaged ? 'packaged EXE' : 'Electron'} environment settings: real detection/IPC, missing tools, progress, duplicate clicks, stale response, errors, themes and WinGet help`);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  website.closeAllConnections(); website.close();
  ws?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, sleep(5000)]);
  }
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('halo-environment-ui-'));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
