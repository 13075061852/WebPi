// Real Electron startup, retry and single-instance checks using only isolated local fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const executableArgument = process.argv.slice(2).find(value => !value.startsWith('--'));
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
  if (process.argv.includes('--close-early')) {
    await waitFor(() => evaluate('!!window.halo'), 'Preload did not load');
    await evaluate('setTimeout(() => window.halo.close(), 30); true');
    await waitFor(() => exitCode !== undefined, 'Close during startup did not exit', 10000);
    assert.equal(exitCode, 0);
    console.log(JSON.stringify({ ok: true, fixture, checks: ['close during initialization exits cleanly without reopening'] }));
  } else {
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(r => r.data)'))?.ready, 'Startup did not finish');
  const state = await evaluate('window.halo.startupState().then(r => r.data)');
  assert.ok(state.timings.windowShown <= state.timings.coreReady, 'The shell must open before the core finishes');
  assert.ok(state.timings.firstPaint <= state.timings.windowShown);
  assert.equal(await evaluate('document.querySelector("#startupProgress").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#btnSend").disabled'), false);

  // Recovery UI must show the exact failure, wrap long detail and never interpret it as markup.
  await evaluate(`window.halo.workspaceReady(${JSON.stringify('恢复测试 <img src=x onerror=alert(1)>：' + '这里是可复制的错误详情。'.repeat(50))})`);
  await waitFor(() => evaluate('!document.querySelector("#startupProgress").hidden && !document.querySelector("#startupRetry").hidden'), 'Recovery controls not visible');
  assert.equal(await evaluate('document.querySelectorAll("#startupDetail img").length'), 0);
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    const layout = await evaluate(`(() => { const p=document.querySelector('#startupProgress'),d=document.querySelector('#startupDetail'); return { fits: p.scrollWidth<=p.clientWidth, bounded:d.clientHeight<=100, text:d.textContent }; })()`);
    assert.ok(layout.fits && layout.bounded, `${theme}: startup error must not overflow`);
    assert.ok(layout.text.includes('<img src=x'));
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(fixture, `startup-${theme}.png`), Buffer.from(screenshot.result.data, 'base64'));
  }
  await evaluate('document.querySelector("#startupRetry").click()');
  await waitFor(() => evaluate('document.querySelector("#startupProgress").hidden'), 'Workspace retry did not recover');
  assert.equal(await evaluate('window.halo.getState().then(r => r.data.model.provider)'), 'startup-fixture');

  const second = spawn(executable, [...(packaged ? [] : ['.']), `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: 'ignore' });
  let secondExit;
  second.on('exit', code => { secondExit = code; });
  try { await waitFor(() => secondExit !== undefined, 'Second instance did not exit', 15000); }
  finally { if (secondExit === undefined) second.kill(); }
  assert.equal(secondExit, 0, 'Launching again must focus the existing app and exit cleanly');
  assert.equal(await evaluate('window.halo.getState().then(r => r.data.ready)'), true);
  // Renderer-triggered close uses the app's real cleanup path while background settings may still be active.
  await evaluate('setTimeout(() => window.halo.close(), 30); true');
  await waitFor(() => exitCode !== undefined, 'Window close did not stop the app', 10000);
  assert.equal(exitCode, 0);
  console.log(JSON.stringify({ ok: true, fixture, timings: state.timings, checks: ['actual startup completion', 'failure details safe and bounded in both themes', 'retry', 'single instance', 'clean close'] }));
  }
} finally {
  fs.writeFileSync(path.join(fixture, 'process.log'), output);
  ws?.close();
  if (exitCode === undefined) child.kill();
}
