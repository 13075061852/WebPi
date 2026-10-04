import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

// Call before importing the real SDK or bridge: both capture the user directory at
// module initialization. Fixtures must never discover personal Pi credentials.
export function isolatePi(name) {
  const originalEnv = { ...process.env };
  const originalHome = os.homedir;
  const originalTmpdir = os.tmpdir;
  const originalFetch = globalThis.fetch;
  const prefix = `halo-${name}-`;
  const fixture = fs.mkdtempSync(path.join(originalTmpdir(), prefix));
  const agentDir = path.join(fixture, '.pi', 'agent');
  const project = path.join(fixture, 'project');
  const windowsRoot = originalEnv.SystemRoot || originalEnv.WINDIR || 'C:\\Windows';
  const allowedEnv = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE']);
  let networkRequests = 0;

  for (const key of Object.keys(process.env)) {
    if (!allowedEnv.has(key.toUpperCase())) delete process.env[key];
  }
  Object.assign(process.env, {
    USERPROFILE: fixture,
    HOME: fixture,
    APPDATA: path.join(fixture, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fixture, 'AppData', 'Local'),
    TEMP: fixture,
    TMP: fixture,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PATH: process.platform === 'win32'
      ? [path.join(windowsRoot, 'System32'), path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter)
      : '/usr/bin:/bin',
  });
  os.homedir = () => fixture;
  os.tmpdir = () => fixture;
  syncBuiltinESMExports();
  globalThis.fetch = async () => {
    networkRequests++;
    throw new Error(`${name} regression must stay offline`);
  };
  for (const dir of [agentDir, project, process.env.APPDATA, process.env.LOCALAPPDATA]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const authFile = path.join(agentDir, 'auth.json');
  fs.writeFileSync(authFile, '{}');

  return {
    fixture,
    agentDir,
    project,
    get networkRequests() { return networkRequests; },
    assertOffline() {
      assert.equal(networkRequests, 0, 'Regression must make no network or model request');
      assert.equal(fs.readFileSync(authFile, 'utf8'), '{}', 'Isolated credentials must remain empty');
    },
    restore() {
      globalThis.fetch = originalFetch;
      os.homedir = originalHome;
      os.tmpdir = originalTmpdir;
      syncBuiltinESMExports();
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      const resolved = path.resolve(fixture);
      assert.equal(path.dirname(resolved), path.resolve(originalTmpdir()));
      assert.ok(path.basename(resolved).startsWith(prefix));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
