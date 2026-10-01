// Optional online IPC/UI check against the real app entrypoint, with an empty
// profile and an SDK fixture that never performs model inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const providedVersion = process.argv.find(value => value.startsWith('--expect-version='))?.slice('--expect-version='.length);
const expectedVersion = providedVersion || '1.0.11';
assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
const packaged = Boolean(process.env.HALO_PACKAGED_EXE);
const executable = path.resolve(process.env.HALO_PACKAGED_EXE || path.join(root, 'node_modules/electron/dist/electron.exe'));
assert.ok(fs.existsSync(executable), 'Build the packaged app or install source Electron before running this optional test');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-history-ui-'));
const profile = path.join(fixture, 'profile'), agent = path.join(fixture, 'agent'), workspace = path.join(fixture, 'workspace');
for (const directory of [profile, agent, workspace]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
const system = process.env.SystemRoot || 'C:/Windows';
const env = {
  SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: agent, PI_HALO_PI_PATH: path.join(root, 'test/fixtures/pi-sdk.js'), PI_OFFLINE: '0',
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const atLeast = (actual, expected) => {
  const left = actual.split('.').map(Number), right = expected.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index];
  return true;
};
let child, ws, output = '', exited, sequence = 0;
const pending = new Map();
const started = Date.now();

async function waitFor(fn, message, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    if (exited !== undefined) throw Error(`App exited before ${message} (code ${exited})`);
    await sleep(100);
  }
  throw Error(message);
}

async function evaluate(expression, timeout = 35000) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Release history app evaluation timed out')); }, timeout);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  assert.equal(response.error, undefined, 'CDP request failed');
  assert.equal(response.result?.exceptionDetails, undefined, 'Release history evaluation threw');
  return response.result?.result?.value;
}

async function synced() {
  return waitFor(async () => {
    const state = await evaluate(`(() => {
      const status = document.querySelector('#releaseHistoryStatus').textContent;
      return { status, disabled: document.querySelector('#releaseHistoryRefresh').disabled };
    })()`);
    if (!state.disabled && state.status.includes('显示本地记录')) throw Error(state.status);
    return !state.disabled && state.status === '已同步 GitHub 正式版本' ? state : null;
  }, 'Release history UI did not synchronize');
}

try {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const args = [...(packaged ? [] : [root]), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
  child = spawn(executable, args, { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-5000); });
  child.on('error', error => { output = error.message; });
  child.on('exit', code => { exited = code; });
  const page = await waitFor(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json();
      return pages.find(item => item.type === 'page' && item.url.endsWith('index.html'));
    } catch { return null; }
  }, 'Main app page did not load');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), request = pending.get(response.id);
    if (request) { clearTimeout(request.timer); pending.delete(response.id); request.resolve(response); }
  });
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(result => result.data)'))?.ready,
    'Isolated fixture startup did not finish');
  const ipc = await evaluate(`window.halo.releaseHistory(true).then(result => ({
    ok: result.ok, error: result.error, versions: result.data?.map(item => item.version)
  }))`);
  assert.equal(ipc.ok, true, ipc.error);
  assert.ok(Array.isArray(ipc.versions) && ipc.versions.length > 0);
  if (providedVersion) assert.equal(ipc.versions[0], expectedVersion, 'IPC must return the expected public latest version');
  else assert.ok(atLeast(ipc.versions[0], expectedVersion), 'IPC must not stop at the outdated bundled 1.0.9 record');
  for (const version of ['1.0.10', expectedVersion]) assert.ok(ipc.versions.includes(version), `Live IPC is missing ${version}`);
  await evaluate('document.querySelector("#btnSettings").click();true');
  await waitFor(() => evaluate('!document.querySelector("#settingsModal").hidden'), 'Settings did not open');
  await evaluate('document.querySelector("#settingsModal .set-nav[data-pane=history]").click();true');
  await waitFor(() => evaluate('document.querySelector("#setPane-history").classList.contains("active")'), 'History pane did not open');
  await synced();
  const rendered = await evaluate(`(() => ({
    versions: [...document.querySelector('#releaseHistoryNav').children].map(item => item.dataset.version),
    latest: document.querySelector('#releaseHistoryList').firstElementChild?.dataset.version,
    current: document.querySelector('#releaseCurrentVersion').textContent
  }))()`);
  assert.equal(rendered.versions[0], ipc.versions[0], 'History navigation must show the live latest release');
  assert.equal(rendered.latest, ipc.versions[0], 'History content must show the live latest release');
  for (const version of ['1.0.10', expectedVersion]) assert.ok(rendered.versions.includes(version));
  const current = await evaluate('window.halo.appUpdateState().then(result => result.data.currentVersion)');
  assert.equal(rendered.current, `当前安装 v${current}`);
  const refreshing = await evaluate(`(() => {
    document.querySelector('#releaseHistoryRefresh').click();
    return { disabled: document.querySelector('#releaseHistoryRefresh').disabled,
      status: document.querySelector('#releaseHistoryStatus').textContent };
  })()`);
  assert.equal(refreshing.disabled, true, 'Manual refresh must start an actual pending refresh');
  assert.equal(refreshing.status, '正在同步版本记录…');
  const refreshed = await synced();
  assert.equal(await evaluate('document.querySelector("#releaseHistoryNav").firstElementChild.dataset.version'), ipc.versions[0]);
  await evaluate('setTimeout(() => window.halo.close(), 30);true');
  await waitFor(() => exited !== undefined, 'App did not close cleanly', 15000);
  assert.equal(exited, 0);
  const result = { passed: true, packaged, currentVersion: current, latestVersion: ipc.versions[0], ipcCount: ipc.versions.length,
    renderedCount: rendered.versions.length, status: refreshed.status, manualRefresh: true, exitCode: exited, elapsedMs: Date.now() - started };
  const report = path.join(root, 'test/results/release-history-app.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS ${packaged ? 'packaged' : 'source'} release history IPC/UI: current ${current}, latest ${result.latestVersion}, ${result.ipcCount} live / ${result.renderedCount} rendered records, ${result.status}, manual refresh and clean close (${result.elapsedMs} ms)`);
} catch (error) {
  // Diagnostics contain only this isolated profile and fixture process.
  fs.mkdirSync(path.join(root, 'test/results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/results/release-history-app-failure.log'), error.message + '\n' + output);
  throw error;
} finally {
  ws?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  if (child && child.exitCode === null) {
    const closed = once(child, 'close'); child.kill(); await Promise.race([closed, sleep(5000)]);
  }
  const target = path.resolve(fixture);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('halo-history-ui-'));
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
