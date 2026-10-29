// Restart the real application against an isolated profile and real CMD shells.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

if (process.platform !== 'win32') { console.log('SKIP terminal memory ConPTY regression: Windows only'); process.exit(0); }
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-terminal-memory-e2e-'));
for (const name of ['profile', 'workspace', 'workspace/subdir', 'agent', 'roaming', 'local', 'gh']) fs.mkdirSync(path.join(fixture, name), { recursive: true });
const profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace'), cwd = path.join(workspace, 'subdir');
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], globalProxy: { mode: 'direct' } }));
fs.writeFileSync(path.join(fixture, 'gitconfig'), '');
const system = process.env.SystemRoot || 'C:/Windows';
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.dirname(process.execPath), path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: path.join(fixture, 'agent'), PI_OFFLINE: '1',
  GH_CONFIG_DIR: path.join(fixture, 'gh'), GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await fn()) return; await sleep(80); }
  throw Error(message);
}
let active;
async function launch() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const exe = process.env.HALO_PACKAGED_EXE || path.resolve('node_modules/electron/dist/electron.exe');
  const child = spawn(exe, [...(process.env.HALO_PACKAGED_EXE ? [] : ['.']), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false, output = '', ws, sequence = 0, page;
  child.on('exit', () => { exited = true; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-20000); });
  active = async () => { ws?.close(); if (!exited) child.kill(); await until(() => exited, 'Fixture did not stop'); fs.appendFileSync(path.join(fixture, 'process.log'), output); };
  await until(async () => {
    if (exited) throw Error(output);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page' && p.url.endsWith('index.html')); } catch {}
    return page;
  }, 'Main page missing');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  const pending = new Map(), errors = [];
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    if (response.method === 'Runtime.exceptionThrown') errors.push(response.params.exceptionDetails);
    pending.get(response.id)?.(response); pending.delete(response.id);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 10000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(response.result?.exceptionDetails, undefined, JSON.stringify(response.result?.exceptionDetails));
    return response.result?.result?.value;
  };
  await send('Runtime.enable');
  await until(async () => (await evaluate('window.halo?.startupState().then(r=>r.data)'))?.ready, 'Startup incomplete');
  await evaluate(`if(document.body.classList.contains('preview-collapsed'))document.querySelector('#btnPreviewToggle').click()`);
  const close = async () => {
    assert.deepEqual(errors, []);
    await evaluate('setTimeout(()=>window.halo.close(),30);true'); await until(() => exited, 'Application did not quit normally');
    await active(); active = null;
  };
  const saved = () => evaluate('window.halo.ptyList().then(r=>r.data)');
  return { send, evaluate, close, saved };
}
try {
  let app = await launch();
  await app.evaluate("document.querySelector('#btnTerm').click()");
  await until(() => app.evaluate("!!document.querySelector('.terminal-panel')?.dataset.pid"), 'First terminal missing');
  await app.evaluate("document.querySelector('#termAdd').click()");
  await until(() => app.evaluate("[...document.querySelectorAll('.terminal-panel')].filter(p=>p.dataset.pid).length===2"), 'Second terminal missing');
  const ids = await app.evaluate("[...document.querySelectorAll('.terminal-panel')].map(p=>p.dataset.terminalId)");
  const marker = path.join(workspace, 'executed.txt');
  const command = `cd /d "${cwd}"\r`;
  await app.evaluate(`window.halo.ptyWrite(${JSON.stringify({ id: ids[0], data: command })})`);
  await app.evaluate(`window.halo.ptyWrite(${JSON.stringify({ id: ids[0], data: `echo RUN_ONCE>>"${marker}" & echo TERMINAL_MEMORY_MARKER\r` })})`);
  await until(async () => (await app.saved()).terminals.some(r => r.id === ids[0] && r.output.includes('TERMINAL_MEMORY_MARKER') && r.cwd === cwd), 'Command/cwd was not saved');
  await app.evaluate("document.querySelector('#termSplit').click()");
  await app.close();
  app = await launch();
  await until(() => app.evaluate("[...document.querySelectorAll('.terminal-panel')].filter(p=>p.dataset.pid).length===2"), 'Saved terminals did not automatically restore');
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.terminal-panel')].map(p=>p.dataset.terminalId)"), ids);
  assert.equal(await app.evaluate("document.querySelector('#termHost').classList.contains('tiled')"), true);
  assert.equal(await app.evaluate("document.querySelector('#cpane-preview').classList.contains('term-open')"), true, 'Restored terminal stays visible when expanding preview');
  const saved = await app.saved();
  assert.equal(saved.activeId, ids[1]);
  assert.ok(saved.terminals[0].output.includes('TERMINAL_MEMORY_MARKER'));
  assert.equal(saved.terminals[0].cwd, cwd);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'RUN_ONCE', 'History replay must never execute old commands');
  await app.evaluate(`window.halo.ptyWrite(${JSON.stringify({ id: ids[0], data: 'echo CWD_RESTORED>%CD%\\cwd-check.txt\r' })})`);
  await until(() => fs.existsSync(path.join(cwd, 'cwd-check.txt')), 'Restored shell did not start in saved cwd');
  await sleep(300);
  const shot = await app.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(fixture, 'restored-terminals.png'), Buffer.from(shot.result.data, 'base64'));
  await app.evaluate("document.querySelector('.terminal-tab button:last-child').click()");
  await until(async () => (await app.saved()).terminals.length === 1, 'Manual close did not forget terminal');
  await app.close();
  app = await launch();
  await until(() => app.evaluate("!!document.querySelector('.terminal-panel')?.dataset.pid"), 'Remaining terminal missing');
  assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.terminal-panel')].map(p=>p.dataset.terminalId)"), [ids[1]]);
  assert.equal(fs.existsSync(path.join(profile, 'terminal-memory', ids[0] + '.log')), false);
  await app.close();
  console.log(JSON.stringify({ ok: true, fixture, checks: ['three application launches', 'stable tabs', 'output/commands', 'cwd', 'active tab', 'split view', 'no command rerun', 'manual close stays deleted'] }));
} finally { await active?.(); }
