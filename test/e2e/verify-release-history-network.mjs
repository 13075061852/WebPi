// Optional online probe. Runs source Electron with no windows or personal profile.
// Do not include this test in the offline regression suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '..', '..');
const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const expectedVersion = process.argv.find(value => value.startsWith('--expect-version='))?.slice('--expect-version='.length) || currentVersion;

function sourceName(url) {
  if (url.startsWith('https://api.github.com/repos/13075061852/WebPi/releases?')) return 'api';
  if (url === 'https://github.com/13075061852/WebPi/releases/latest') return 'latest';
  if (url === 'https://github.com/13075061852/WebPi/releases.atom') return 'atom';
  throw Error('Unexpected network destination');
}

function manualEndpoint(server) {
  const entries = String(server).split(';').map(value => value.trim());
  const selected = entries.find(value => /^https=/i.test(value))?.replace(/^https=/i, '')
    || entries.find(value => !value.includes('='));
  return selected?.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
}

async function probe() {
  const { app, session } = await import('electron');
  const { GlobalProxy } = await import('../../src/main/global-proxy.mjs');
  const { WindowsSystemProxy } = await import('../../src/main/windows-system-proxy.mjs');
  const { createReleaseHistoryFetch } = await import('../../src/main/release-history-fetch.mjs');
  const { createReleaseHistory } = await import('../../src/main/release-history.mjs');
  const profile = process.env.HALO_HISTORY_NETWORK_PROFILE;
  assert.ok(profile && process.env.HALO_HISTORY_NETWORK_REPORT, 'Run this probe through its Node parent');
  app.setPath('userData', profile);
  const system = new WindowsSystemProxy();
  const transport = createReleaseHistoryFetch({ app, session });
  const controller = new GlobalProxy({ data: {}, set() { throw Error('The probe must not save configuration'); } }, { system });
  const routingErrors = [];
  app.on('session-created', created => {
    if (transport.ownsSession(created)) return;
    void controller.addSession(created).catch(error => routingErrors.push(error.message));
  });
  let historySession, before, after, result, exitCode = 0;
  const requests = [];
  try {
    if (process.platform === 'win32') before = await system.read();
    await app.whenReady();
    await controller.addSession(session.defaultSession);
    assert.equal(controller.state().mode, 'direct', 'Missing app configuration must exercise the existing direct route');
    assert.equal(await session.defaultSession.resolveProxy('https://github.com'), 'DIRECT');
    const tracedFetch = async (url, options) => {
      const source = sourceName(url);
      assert.equal(options?.headers?.Authorization, undefined, 'Release reads must not include account credentials');
      const response = await transport.fetch(url, options);
      requests.push({ scenario: 'normal', source, status: response.status });
      return response;
    };
    const normal = await createReleaseHistory({ fetchImpl: tracedFetch })();
    assert.equal(normal[0]?.version, expectedVersion, 'Normal system-routed history must retrieve the latest public release');
    historySession = session.fromPartition('halo-release-history', { cache: false });
    assert.equal(transport.ownsSession(historySession), true);
    assert.equal(controller.sessions.has(historySession), false, 'The app direct route must not overwrite the history system route');
    const proxyRoute = await historySession.resolveProxy('https://github.com');
    if (before && before.flags === 1) assert.equal(proxyRoute, 'DIRECT');
    if (before && (before.flags & 2) && !(before.flags & 12)) {
      const endpoint = manualEndpoint(before.server);
      if (endpoint && /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/i.test(endpoint)) {
        assert.ok(proxyRoute.split(';').some(route => route.trim().endsWith(` ${endpoint}`)),
          'History must use the live Windows loopback proxy rather than the app default direct route');
      }
    }
    const rateLimitedFetch = async (url, options) => {
      const source = sourceName(url);
      if (source === 'api') {
        requests.push({ scenario: 'rate-limit', source, status: 403, injected: true });
        return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      }
      const response = await transport.fetch(url, options);
      requests.push({ scenario: 'rate-limit', source, status: response.status });
      return response;
    };
    const fallback = await createReleaseHistory({ fetchImpl: rateLimitedFetch })();
    assert.equal(fallback[0]?.version, expectedVersion, 'Live website fallback must retrieve the latest public release');
    for (const source of ['latest', 'atom']) {
      assert.ok(requests.some(row => row.scenario === 'rate-limit' && row.source === source && row.status === 200));
    }
    assert.deepEqual(routingErrors, []);
    if (before) {
      after = await system.read();
      assert.deepEqual(after, before, 'The probe must leave Windows system proxy configuration unchanged');
    }
    result = { passed: true, expectedVersion, normal: { count: normal.length, version: normal[0].version },
      fallback: { count: fallback.length, version: fallback[0].version }, requests,
      proxyRoute, systemProxyUnchanged: before ? true : null,
      electron: process.versions.electron, node: process.versions.node };
  } catch (error) {
    exitCode = 1;
    if (before && !after) {
      try { after = await system.read(); } catch {}
    }
    result = { passed: false, expectedVersion, error: error.message, requests,
      systemProxyUnchanged: before && after ? JSON.stringify(before) === JSON.stringify(after) : null };
  } finally {
    await historySession?.closeAllConnections().catch(() => {});
    await controller.dispatcher.close().catch(() => {});
    fs.writeFileSync(process.env.HALO_HISTORY_NETWORK_REPORT, JSON.stringify(result, null, 2));
    app.exit(exitCode);
  }
}

async function parent() {
  const executable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  assert.ok(fs.existsSync(executable), 'Install the local Electron runtime before running this optional test');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-history-network-'));
  const report = path.join(dir, 'report.json'), profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)KEY(?:_|$))/i.test(key)));
  for (const key of Object.keys(env)) {
    if (/^(?:http_proxy|https_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options|electron_run_as_node)$/i.test(key)) delete env[key];
  }
  Object.assign(env, { USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'),
    PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PI_OFFLINE: '1',
    HALO_HISTORY_NETWORK_PROFILE: profile, HALO_HISTORY_NETWORK_REPORT: report });
  let child, output = '';
  const started = Date.now();
  try {
    const exited = await new Promise((resolve, reject) => {
      child = spawn(executable, [here, `--expect-version=${expectedVersion}`, `--user-data-dir=${profile}`, '--disable-gpu'],
        { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(Error('Release history network probe timed out')); }, 90000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    assert.ok(fs.existsSync(report), `Network probe returned no report (exit ${exited}): ${output}`);
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    result.elapsedMs = Date.now() - started;
    const destination = path.join(root, 'test', 'results', 'release-history-network.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
    assert.equal(exited, 0, result.error || output);
    assert.equal(result.passed, true, result.error);
    console.log(`PASS live release history: ${result.normal.version}, normal ${result.normal.count}, rate-limit fallback ${result.fallback.count}, ${result.proxyRoute}, Windows proxy unchanged (${result.elapsedMs} ms)`);
  } finally {
    if (child && child.exitCode === null) child.kill();
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('halo-history-network-'));
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

// Electron delays app readiness until its main module loads. Do not top-level
// await the probe that itself waits for app.whenReady().
if (process.versions.electron) void probe().catch(async error => {
  process.stderr.write(error.message + '\n');
  const { app } = await import('electron');
  app.exit(1);
});
else await parent();
