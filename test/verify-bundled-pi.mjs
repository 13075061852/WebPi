import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// Use the real production SDK with no global Pi, credentials, user extensions,
// Git Bash or Node on PATH. No model request is made by this regression.
const originalEnv = { ...process.env };
const originalHome = os.homedir;
const originalTmpdir = os.tmpdir;
const originalFetch = globalThis.fetch;
const fixture = fs.mkdtempSync(path.join(originalTmpdir(), 'halo-bundled-pi-'));
const agentDir = path.join(fixture, '.pi', 'agent');
const project = path.join(fixture, 'project');
const windowsRoot = originalEnv.SystemRoot || originalEnv.WINDIR || 'C:\\Windows';
const allowedEnv = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE']);
// Hosted Windows runners take ~29s to initialize PowerShell with a fresh HOME.
// Keep the desktop deadline strict; only this integration fixture gets CI headroom.
const shellTimeoutSeconds = process.platform === 'win32' && originalEnv.GITHUB_ACTIONS === 'true' ? 60 : 15;
let bridge;
let networkRequests = 0;

try {
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
    throw new Error('Bundled Pi regression must stay offline');
  };
  for (const dir of [agentDir, project, process.env.APPDATA, process.env.LOCALAPPDATA]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');

  const { resolvePiEntry, resolvePiCli } = await import('../src/main/pi-runtime.mjs');
  const sdkRoot = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url));
  assert.equal(resolvePiEntry(), path.join(sdkRoot, 'dist', 'index.js'));
  assert.equal(resolvePiCli(), path.join(sdkRoot, 'dist', 'bundle', 'cli.js'));
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const sdkManifest = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@earendil-works/pi-coding-agent'], sdkManifest.version, 'Production SDK version must be pinned');

  const { PiBridge, HaloStore, loadPi } = await import('../src/main/pi-bridge.mjs');
  const sdk = await loadPi();
  assert.equal(sdk.getAgentDir(), agentDir);
  bridge = new PiBridge(new HaloStore(path.join(fixture, 'halo.json')), {}, { sessionDir: path.join(fixture, 'sessions') });
  bridge.modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
  const state = await bridge.start(project);
  assert.equal(state.ready, true);
  assert.ok(bridge.session.sessionId);
  assert.ok(bridge.services.resourceLoader.getSkills().skills.length > 0, 'Bundled Office skills remain discoverable');
  const expectedTools = ['read', process.platform === 'win32' ? 'powershell' : 'bash', 'edit', 'write'];
  assert.deepEqual(bridge.session.getActiveToolNames().filter(name => ['read', 'powershell', 'bash', 'edit', 'write'].includes(name)), expectedTools);
  assert.equal(bridge.services.settingsManager.getGlobalSettings().defaultTools, undefined, 'Windows defaults must not overwrite shared Pi settings');

  const tools = new Map(bridge.session.agent.state.tools.map(tool => [tool.name, tool]));
  assert.ok(tools.has('video_generate'), 'Video generation must be available to the actual Pi agent');
  bridge.video = { run: async (_id, args, cwd) => ({ status: 'fixture', action: args.action, cwd }) };
  const video = await tools.get('video_generate').execute('video-fixture', { action: 'list' });
  assert.equal(path.resolve(video.details.cwd), path.resolve(project));
  await tools.get('write').execute('write-fixture', { path: 'fixture.txt', content: 'bundled SDK works\n' });
  const read = await tools.get('read').execute('read-fixture', { path: 'fixture.txt' });
  assert.match(read.content.map(part => part.text || '').join('\n'), /bundled SDK works/);
  assert.equal(fs.readFileSync(path.join(project, 'fixture.txt'), 'utf8'), 'bundled SDK works\n');
  if (process.platform === 'win32') {
    const shellStartedAt = performance.now();
    const result = await tools.get('powershell').execute('shell-fixture', {
      command: "[IO.File]::ReadAllText((Join-Path (Get-Location) 'fixture.txt'))",
      timeout: shellTimeoutSeconds,
    });
    assert.match(result.content.map(part => part.text || '').join('\n'), /bundled SDK works/);
    console.log(`PASS isolated PowerShell read in ${Math.round(performance.now() - shellStartedAt)}ms (deadline ${shellTimeoutSeconds}s)`);
  }

  // Explicit choices, including a read-only configuration, survive restart.
  await bridge.dispose();
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultTools: ['read'] }));
  await bridge.start(project);
  assert.equal(bridge.session.getActiveToolNames().includes('powershell'), false);
  assert.equal(bridge.session.getActiveToolNames().includes('bash'), false);
  assert.deepEqual(bridge.services.settingsManager.getDefaultTools(), ['read']);
  assert.equal(networkRequests, 0, 'Cold startup and local tools must not need a model request');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8')), {});
  console.log('PASS bundled Pi cold start, pinned SDK, isolated credentials, local read/write, Windows PowerShell and preserved settings');
} finally {
  await bridge?.dispose();
  globalThis.fetch = originalFetch;
  os.homedir = originalHome;
  os.tmpdir = originalTmpdir;
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  const resolvedFixture = path.resolve(fixture);
  assert.equal(path.dirname(resolvedFixture), path.resolve(originalTmpdir()));
  assert.ok(path.basename(resolvedFixture).startsWith('halo-bundled-pi-'));
  fs.rmSync(resolvedFixture, { recursive: true, force: true });
}
