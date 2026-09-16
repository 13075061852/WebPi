// Cold start the actual packaged app without global Pi, Node, Bash or accounts.
// A local mock provider drives real SDK write/PowerShell tools and streamed UI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { spawnPi } from '../../src/main/pi-command.mjs';

const exe = path.resolve(process.env.HALO_PACKAGED_EXE || 'dist/win-unpacked/Pi Halo.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-bundled-pi-'));
const workspace = path.join(dir, 'workspace'), agentDir = path.join(dir, 'agent'), userData = path.join(dir, 'user-data');
for (const p of [workspace, agentDir, userData]) fs.mkdirSync(p, { recursive: true });
const calls = [], sockets = new Set();
let child, ws, output = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls.push(body);
  const completed = body.messages.filter(m => m.role === 'tool').length;
  const action = completed === 0 ? { name: 'write', arguments: JSON.stringify({ path: 'engine-check.txt', content: 'bundled-pi-ok' }) }
    : completed === 1 ? { name: 'powershell', arguments: JSON.stringify({ command: "Get-Content -LiteralPath './engine-check.txt'" }) } : null;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (action) {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `tool-${completed}`, type: 'function', function: action }] });
    chunk({}, 'tool_calls');
  } else { chunk({ role: 'assistant', content: 'BUNDLED_PI_READY' }); chunk({}, 'stop'); }
  res.end('data: [DONE]\n\n');
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'halo-fixture': { baseUrl, api: 'openai-completions', apiKey: 'fixture-only', models: [{ id: 'fixture', name: 'Offline fixture', contextWindow: 32000, maxTokens: 2048 }] },
  } }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'halo-fixture', defaultModel: 'fixture' }));
  fs.writeFileSync(path.join(userData, 'halo-settings.json'), JSON.stringify({ cwd: workspace, modelKey: 'halo-fixture/fixture', projects: [{ cwd: workspace }], splashed: true }));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const system = process.env.SystemRoot || 'C:/Windows';
  const env = {
    SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32', 'cmd.exe'),
    PATH: [path.join(system, 'System32'), path.join(system, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
    USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'),
    TEMP: dir, TMP: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', NO_PROXY: '*',
  };
  child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-5000); });
  let page;
  for (let n = 0; n < 120 && !page; n++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json();
      page = pages.find(p => p.type === 'page' && p.url.endsWith('index.html'));
    } catch {}
    if (!page) await sleep(250);
  }
  assert.ok(page, `Packaged app did not open: ${output}`);
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  let messageId = 0; const pending = new Map();
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data); const request = pending.get(data.id);
      if (request) { pending.delete(data.id); clearTimeout(request.timer); request.resolve(data); }
  });
  async function evaluate(expression, deadline = 15000) {
    const reply = await new Promise((resolve, reject) => {
      const id = ++messageId;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Packaged app stopped responding after ${deadline}ms: ${output}`)); }, deadline);
      pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    assert.equal(reply.result?.exceptionDetails, undefined, JSON.stringify(reply));
    return reply.result?.result?.value;
  }
  let state;
  for (let n = 0; n < 160; n++) {
    state = await evaluate('window.halo?.getState()');
    if (state?.data?.ready) break;
    await sleep(250);
  }
  assert.equal(state?.data?.ready, true, `Bundled SDK failed to start: ${output}`);
  assert.equal(state.data.model?.provider, 'halo-fixture');
  const auth = await evaluate('window.halo.authProviders()');
  assert.equal(auth.ok, true, 'Bundled provider login implementation is available');
  // This promise includes a real PowerShell launch with a fresh isolated HOME.
  // Hosted Windows initialization took ~29s; ordinary IPC keeps its 15s deadline.
  const promptDeadline = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' ? 60000 : 15000;
  const promptStartedAt = performance.now();
  const result = await evaluate('window.halo.prompt("Run the offline engine verification")', promptDeadline);
  assert.equal(result.ok, true, JSON.stringify(result));
  console.log(`PASS packaged write/PowerShell turn in ${Math.round(performance.now() - promptStartedAt)}ms (deadline ${promptDeadline}ms)`);
  assert.equal(fs.readFileSync(path.join(workspace, 'engine-check.txt'), 'utf8'), 'bundled-pi-ok');
  assert.equal(calls.length, 3, 'Real SDK must execute both local tools before the final answer');
  assert.ok(calls[0].tools.some(t => t.function.name === 'powershell'));
  assert.ok(!calls[0].tools.some(t => t.function.name === 'bash'));
  const toolResults = calls.at(-1).messages.filter(m => m.role === 'tool');
  assert.ok(toolResults.some(m => String(m.content).includes('bundled-pi-ok')), 'Native PowerShell read must succeed');
  await sleep(300);
  assert.ok(await evaluate('document.querySelector("#messages").textContent.includes("BUNDLED_PI_READY")'), 'Streamed response should render');
  const cliPath = path.join(path.dirname(exe), 'resources/app.asar.unpacked/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  const cli = await spawnPi(['--version'], { executable: exe, cliPath, env, cwd: workspace, timeout: 15000 });
  assert.equal(cli.ok, true, JSON.stringify(cli));
  assert.ok(cli.output.includes(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies['@earendil-works/pi-coding-agent']));
  console.log('PASS packaged Pi cold start, provider loading, real write/PowerShell tools, streamed conversation and bundled CLI without global Pi/Node/Bash');
} finally {
  ws?.close();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, sleep(5000)]);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('halo-bundled-pi-'));
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
