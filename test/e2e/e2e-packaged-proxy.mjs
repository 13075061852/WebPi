// Exercise the real EXE entrypoint with an offline SDK fixture. No OpenAI calls,
// real accounts, fixed proxy ports, or changes to the user's environment.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

const expectDirect = process.argv.includes('--expect-direct');
const useElectron = process.argv.includes('--electron');
const exe = path.resolve(useElectron ? 'node_modules/electron/dist/electron.exe' : 'dist/win-unpacked/Pi Halo.exe');
assert.ok(fs.existsSync(exe), 'Build the Windows app first');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-exe-proxy-'));
const sockets = new Set(), servers = [], seen = [];
let child;
async function listen(server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const response = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(gzipSync(JSON.stringify({ fixture: true })));
  };
  const originPort = await listen(http.createServer(response));
  const bypassPort = await listen(http.createServer(response));
  async function proxy(label) {
    const server = http.createServer();
    server.on('connect', (req, socket, head) => {
      seen.push({ label, target: req.url });
      if (label === 'https') { socket.end('HTTP/1.1 502 Fixture HTTPS tunnel observed\r\nConnection: close\r\n\r\n'); return; }
      // Only the controlled origin is allowed through this test proxy.
      if (req.url !== `127.0.0.1:${originPort}`) { socket.destroy(); return; }
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    });
    return `http://127.0.0.1:${await listen(server)}`;
  }
  const httpProxy = await proxy('http'), httpsProxy = await proxy('https');
  const report = path.join(dir, 'report.json'), sdk = path.join(dir, 'pi-sdk.js');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  // Pi calls initTheme immediately after importing its SDK: this verifies that
  // proxy initialization happened before any SDK login/provider code could run.
  fs.writeFileSync(sdk, fs.readFileSync('test/fixtures/pi-sdk.js', 'utf8') + `
exports.initTheme = () => {
  (async () => {
    const init = { signal: AbortSignal.timeout(7000) };
    const proxied = await (await fetch(${JSON.stringify(`http://127.0.0.1:${originPort}/token-fixture`)}, init)).json();
    const direct = await (await fetch(${JSON.stringify(`http://127.0.0.1:${bypassPort}/bypass`)}, init)).json();
    let httpsRejected = false;
    try { await fetch(${JSON.stringify(`https://127.0.0.1:${originPort}/token-fixture`)}, init); } catch { httpsRejected = true; }
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ proxied, direct, httpsRejected, node: process.versions.node, electron: process.versions.electron }));
  })().catch(error => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ error: error.message })));
};
`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(http_proxy|https_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options|electron_run_as_node)$/i.test(key)) delete env[key];
  Object.assign(env, {
    HTTP_PROXY: httpProxy, HTTPS_PROXY: httpsProxy, NO_PROXY: `127.0.0.1:${bypassPort}`,
    USERPROFILE: dir, PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PI_HALO_PI_PATH: sdk,
  });
  const args = [`--user-data-dir=${path.join(dir, 'user-data')}`];
  if (useElectron) args.unshift(path.resolve('dist/win-unpacked/resources/app.asar'));
  child = spawn(exe, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
  child.on('error', () => {});
  for (let n = 0; n < 120 && !fs.existsSync(report) && child.exitCode === null; n++) await sleep(250);
  assert.ok(fs.existsSync(report), `EXE did not complete its fixture (exit ${child.exitCode}): ${output}`);
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(result.error, undefined);
  assert.equal(result.proxied.fixture, true, 'Gzip JSON is decoded correctly');
  assert.equal(result.direct.fixture, true);
  assert.equal(result.httpsRejected, true);
  if (expectDirect) assert.equal(seen.length, 0, 'The old EXE should demonstrate the skipped proxy initialization');
  else {
    assert.ok(seen.some(row => row.label === 'http' && row.target === `127.0.0.1:${originPort}`));
    assert.ok(seen.some(row => row.label === 'https' && row.target === `127.0.0.1:${originPort}`));
    assert.ok(seen.every(row => row.target !== `127.0.0.1:${bypassPort}`), 'NO_PROXY must bypass both proxies');
  }
  console.log(`${expectDirect ? 'REPRODUCED old EXE bypassing environment proxies' : 'PASS packaged EXE HTTP/HTTPS proxy routing, dynamic ports, NO_PROXY and gzip JSON'} (Electron ${result.electron}, Node ${result.node})`);
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, sleep(5000)]);
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  const resolved = path.resolve(dir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('halo-exe-proxy-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
