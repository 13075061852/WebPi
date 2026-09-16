// Compare packaged startup with isolated accounts, profiles and a local model fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const exe = path.resolve(process.argv[2] || 'dist/win-unpacked/Pi Halo.exe');
const runs = Number(process.argv[3] || 3);
const label = process.argv[4] || 'current';
assert.ok(fs.existsSync(exe), `Missing executable: ${exe}`);
const parent = path.resolve('tmp/startup-performance');
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, label + '-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];

for (let run = 0; run < runs; run++) {
  const dir = path.join(root, String(run));
  const workspace = path.join(dir, 'workspace'), agent = path.join(dir, 'agent'), profile = path.join(dir, 'profile');
  for (const folder of [workspace, agent, profile]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: {
    'startup-fixture': { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'offline-fixture', models: [{ id: 'fixture', name: 'Startup fixture', contextWindow: 32000, maxTokens: 2048 }] },
  } }));
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'startup-fixture', defaultModel: 'fixture' }));
  fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, modelKey: 'startup-fixture/fixture', projects: [{ cwd: workspace }], splashed: false }));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const system = process.env.SystemRoot || 'C:/Windows';
  const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
    PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
    USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'),
    TEMP: dir, TMP: dir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', NO_PROXY: '*', HALO_STARTUP_TRACE: '1' };
  const started = performance.now();
  const child = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', ws, sequence = 0;
  const pending = new Map();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-16000); });
  child.on('error', error => { output += error.message; });
  try {
    let page;
    while (!page && performance.now() - started < 45000) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(800) })).json()).find(p => p.type === 'page' && p.url.endsWith('index.html')); } catch { /* Process still starting. */ }
      if (!page) await sleep(60);
    }
    assert.ok(page, `Main window did not load: ${output}`);
    const mainPageMs = Math.round(performance.now() - started);
    ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
    ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
    const evaluate = async expression => {
      let timer;
      const response = await Promise.race([new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Renderer did not respond in 5 s')), 5000); })]).finally(() => clearTimeout(timer));
      assert.equal(response.result?.exceptionDetails, undefined, JSON.stringify(response.result?.exceptionDetails));
      return response.result?.result?.value;
    };
    let state;
    while (performance.now() - started < 45000) {
      state = await evaluate('window.halo?.getState()');
      if (state?.data?.ready) break;
      await sleep(60);
    }
    assert.equal(state?.data?.ready, true, `Core initialization failed: ${output}`);
    assert.equal(state.data.model?.provider, 'startup-fixture');
    const coreReadyMs = Math.round(performance.now() - started);
    const responsiveness = await evaluate(`new Promise(resolve => { const gaps=[]; let previous=performance.now(); const timer=setInterval(()=>{ const now=performance.now(); gaps.push(now-previous); previous=now; if(gaps.length===30){clearInterval(timer); resolve({maxGapMs:Math.round(Math.max(...gaps)),samples:gaps.length});}},16); })`);
    const result = { run: run + 1, mainPageMs, coreReadyMs, ...responsiveness };
    results.push(result); fs.writeFileSync(path.join(dir, 'process.log'), output); console.log(JSON.stringify(result));
  } finally {
    ws?.close(); child.kill();
    await Promise.race([once(child, 'exit').catch(() => {}), sleep(4000)]);
  }
}
const median = key => results.map(r => r[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
const report = { label, executable: exe, root, results, medianMainPageMs: median('mainPageMs'), medianCoreReadyMs: median('coreReadyMs') };
fs.writeFileSync(path.join(parent, label + '.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
