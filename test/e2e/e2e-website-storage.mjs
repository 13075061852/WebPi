// Real webview login persistence, using an isolated profile and loopback-only site.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-website-storage-'));
const profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace');
for (const name of ['profile', 'workspace', 'agent', 'roaming', 'local', 'gh']) fs.mkdirSync(path.join(fixture, name));
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], globalProxy: { mode: 'direct' } }));
fs.writeFileSync(path.join(fixture, 'gitconfig'), '');
const system = process.env.SystemRoot || 'C:/Windows';
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.dirname(process.execPath), path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: path.join(fixture, 'agent'), PI_OFFLINE: '1',
  GH_CONFIG_DIR: path.join(fixture, 'gh'), GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(80); }
  throw Error(message);
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/login') {
    res.setHeader('Set-Cookie', 'fixture_login=active; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600');
  } else if (req.url === '/logout') {
    res.setHeader('Set-Cookie', 'fixture_login=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  }
  const loggedIn = req.url === '/login' || (req.url !== '/logout' && req.headers.cookie?.includes('fixture_login=active'));
  res.end(`<title>浏览器登录记忆测试</title><h1>${loggedIn ? '已登录' : '请登录'}</h1>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let active;
async function launch() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const packaged = Boolean(process.env.HALO_PACKAGED_EXE);
  const executable = process.env.HALO_PACKAGED_EXE || (process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron');
  const child = spawn(path.resolve(executable), [...(packaged ? [] : ['.']), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', ws, exited = false, sequence = 0;
  child.on('error', error => { output += error.message; });
  child.on('exit', () => { exited = true; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-20000); });
  const stop = async () => {
    ws?.close();
    if (!exited) child.kill();
    await waitFor(() => exited, 'Fixture Electron did not exit');
    fs.appendFileSync(path.join(fixture, 'process.log'), output);
  };
  active = { stop };
  let page;
  await waitFor(async () => {
    if (exited) throw Error(output);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page' && p.url.endsWith('index.html')); } catch {}
    return page;
  }, 'Main page did not load');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  const pending = new Map(), errors = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    pending.get(message.id)?.(message); pending.delete(message.id);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 10000);
    pending.set(id, result => { clearTimeout(timer); resolve(result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(response.result?.exceptionDetails, undefined, JSON.stringify(response.result?.exceptionDetails));
    return response.result?.result?.value;
  };
  await send('Runtime.enable');
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(r=>r.data)'))?.ready, 'Startup did not finish');
  await evaluate(`if (document.querySelector('#btnPreviewToggle').getAttribute('aria-expanded')==='false') document.querySelector('#btnPreviewToggle').click()`);
  const open = async (route = '/') => {
    await evaluate(`document.querySelector('#btnBrowser').click(); document.querySelector('#previewAddress').value=${JSON.stringify(origin + route)};document.querySelector('#previewAddressForm').requestSubmit()`);
    await waitFor(() => evaluate(`(() => {try { const g=document.querySelector('webview'); return g && g.getURL()===${JSON.stringify(origin + route)} && !g.isLoading(); } catch {return false;} })()`), 'Website did not load');
  };
  const guest = expression => evaluate(`document.querySelector('webview').executeJavaScript(${JSON.stringify(expression)})`);
  const close = async () => {
    assert.deepEqual(errors, [], 'No renderer errors');
    await evaluate('setTimeout(()=>window.halo.close(),30);true');
    await waitFor(() => exited, 'Normal application shutdown failed');
    await stop(); active = null;
  };
  return { open, guest, close, evaluate, send };
}
try {
  let app = await launch();
  await app.open('/login');
  await app.guest(`localStorage.setItem('fixture-token','saved'); sessionStorage.setItem('temporary','tab-only'); true`);
  assert.equal(await app.guest('document.querySelector("h1").textContent'), '已登录');
  // Recreating the guest keeps durable storage but starts a new tab session.
  const oldId = await app.evaluate("document.querySelector('webview').getWebContentsId()");
  await app.evaluate("document.querySelector('#pvBody').replaceChildren()");
  await app.open();
  assert.notEqual(await app.evaluate("document.querySelector('webview').getWebContentsId()"), oldId);
  assert.equal(await app.guest('localStorage.getItem("fixture-token")'), 'saved');
  assert.equal(await app.guest('sessionStorage.getItem("temporary")'), null);
  assert.equal(await app.guest('document.querySelector("h1").textContent'), '已登录');
  await app.guest("history.pushState(null,'','/remembered?tab=history');true");
  await waitFor(() => app.evaluate("document.querySelector('.website-toolbar input').value.endsWith('/remembered?tab=history')"), 'Navigated URL did not synchronize');
  await app.evaluate("document.querySelector('#btnBrowser').click()");
  assert.equal(await app.evaluate("!!document.querySelector('#pvBody webview')"), false);
  await app.close();
  app = await launch();
  assert.equal(await app.evaluate("!!document.querySelector('#pvBody webview')"), false, 'Exited preview stays exited after restart');
  await app.evaluate("document.querySelector('#btnBrowser').click()");
  await waitFor(() => app.evaluate(`(() => {try {const g=document.querySelector('webview');return g?.getURL()===${JSON.stringify(origin + '/remembered?tab=history')} && !g.isLoading();}catch{return false;}})()`), 'Reenter after application restart did not restore the last navigated address');
  assert.equal(await app.guest('localStorage.getItem("fixture-token")'), 'saved', 'Local storage must survive application restart');
  assert.equal(await app.guest('document.querySelector("h1").textContent'), '已登录', 'HttpOnly login cookie must survive application restart');
  assert.equal(await app.guest('typeof require'), 'undefined', 'Persistent guest stays sandboxed');
  const shot = await app.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(fixture, 'website-login-restored.png'), Buffer.from(shot.result.data, 'base64'));
  await app.open('/logout'); await app.guest('localStorage.removeItem("fixture-token");true');
  await app.close();
  app = await launch(); await app.open();
  assert.equal(await app.guest('localStorage.getItem("fixture-token")'), null, 'Logout must not resurrect stored tokens');
  assert.equal(await app.guest('document.querySelector("h1").textContent'), '请登录', 'Deleted cookies must remain deleted after restart');
  await app.close();
  console.log(JSON.stringify({ ok: true, fixture, checks: ['recreated webview', 'restart localStorage', 'restart HttpOnly cookie', 'tab-only sessionStorage', 'sandbox', 'logout persists'] }));
} finally {
  await active?.stop();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
