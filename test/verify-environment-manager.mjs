import assert from 'node:assert/strict';
import { EnvironmentManager, installArguments, runEnvironmentInstaller } from '../src/main/environment-manager.mjs';

const ids = ['python', 'node', 'git'];
function fixture(initial = [], installerAvailable = true) {
  const installed = new Set(initial), calls = [], changes = [];
  let refreshed = 0, response = { code: 0 }, apply = true;
  const manager = new EnvironmentManager({
    detect: async () => ({ platform: 'win32', installer: { available: installerAvailable, path: 'C:\\WindowsApps\\winget.exe' },
      tools: ids.map(id => ({ id, name: id, installed: installed.has(id), version: installed.has(id) ? '1.2.3' : null })), updatedAt: new Date().toISOString() }),
    refreshPath: async () => { refreshed++; },
    run: async (executable, args, { onOutput }) => {
      const id = ids.find(id => installArguments(id, {})[2] === args[2]);
      calls.push({ id, executable, args });
      onOutput('Downloading fixture');
      if (apply) installed.add(id);
      return response;
    },
    onChange: state => changes.push(state),
  });
  return { manager, installed, calls, changes, refreshed: () => refreshed,
    fail: result => { response = result; apply = false; }, succeed: () => { response = { code: 0 }; apply = true; } };
}

// Fixed package IDs and global installation; never take arbitrary commands from the renderer.
for (const id of ids) {
  const args = installArguments(id, {});
  assert.equal(args[args.indexOf('--scope') + 1], 'machine');
  assert.ok(!args.includes('--no-upgrade'));
  assert.ok(!args.includes('--disable-interactivity'), 'Support old WinGet versions');
  assert.equal(args[args.indexOf('--source') + 1], 'winget');
}
assert.throws(() => installArguments('arbitrary-package'), /不支持/);
assert.deepEqual(installArguments('git', { HTTPS_PROXY: 'http://127.0.0.1:38471' }).slice(-2), ['--proxy', 'http://127.0.0.1:38471']);
assert.ok(!installArguments('git', { ALL_PROXY: 'socks5://127.0.0.1:1080' }).includes('--proxy'));

{
  const f = fixture(['node']);
  f.manager.progress('python', 'error', 'unsupported --disable-interactivity');
  const prompt = await f.manager.repairPrompt();
  assert.match(prompt, /unsupported --disable-interactivity/);
  assert.match(prompt, /不可信诊断数据/);
  assert.doesNotMatch(prompt, /"id":"node"/, 'Healthy tools are omitted from repair scope');
  const healthy = fixture(ids);
  healthy.manager.progress('python', 'error', 'Old failure before installation succeeded');
  assert.equal(await healthy.manager.repairPrompt(), null, 'Healthy environment skips AI despite old errors');
  assert.equal(f.calls.length, 0, 'Preparing AI diagnostics must not run an installer');
  f.manager.state.installing = true;
  await assert.rejects(f.manager.repairPrompt(), /等待自动配置/);
}

// Double clicks join one job. Existing tools stay untouched; PATH is refreshed before re-detection.
{
  const f = fixture(['node']);
  assert.equal(f.manager.start().installing, true);
  const job = f.manager.job;
  f.manager.start();
  assert.equal(f.manager.job, job);
  assert.equal((await f.manager.status()).installing, true);
  await job;
  assert.deepEqual(f.calls.map(call => call.id), ['python', 'git']);
  assert.equal(f.refreshed(), 2);
  assert.ok(f.manager.snapshot().tools.every(tool => tool.installed));
  assert.equal(f.manager.snapshot().installing, false);
  assert.equal(f.manager.snapshot().progress.at(-1).state, 'done');
  assert.ok(f.changes.every((state, index) => !index || state.revision > f.changes[index - 1].revision));
  const copy = f.manager.snapshot(); copy.tools[0].installed = false;
  assert.equal(f.manager.snapshot().tools[0].installed, true);
}

// No need for WinGet when tools are ready; never run an installer without WinGet.
for (const installed of [ids, []]) {
  const f = fixture(installed, false);
  f.manager.start(); await f.manager.job;
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.snapshot().progress.at(-1).state, installed.length ? 'done' : 'error');
  assert.equal(f.manager.snapshot().installing, false);
}

// A zero exit code alone is not proof of usable tools. Retry only the remaining tool.
{
  const f = fixture(['node', 'git']);
  f.fail({ code: 0 }); f.manager.start(); await f.manager.job;
  assert.equal(f.manager.snapshot().tools[0].installed, false);
  assert.ok(f.manager.snapshot().progress.some(p => p.message.includes('尚未检测到')));
  f.succeed(); f.manager.start(); await f.manager.job;
  assert.deepEqual(f.calls.map(call => call.id), ['python', 'python']);
  assert.equal(f.manager.snapshot().progress.at(-1).state, 'done');
}

// Network failures stay visible; cancellation/timeout stops remaining installers.
for (const response of [{ code: -1, output: 'fixture download failed' }, { code: 0x8a15010c | 0 }, { code: 1602 }, { code: -1, timedOut: true, error: 'timeout' }]) {
  const f = fixture(); f.fail(response); f.manager.start(); await f.manager.job;
  assert.equal(f.calls.length, response.output ? 3 : 1);
  assert.equal(f.manager.snapshot().installing, false);
  assert.equal(f.manager.snapshot().progress.at(-1).state, 'error');
}

// Installation waits for an already-running detection, then rechecks before installing.
{
  const f = fixture(ids);
  let resolve;
  const original = f.manager.detect;
  f.manager.detect = () => new Promise(done => { resolve = done; });
  const status = f.manager.status();
  f.manager.start();
  f.manager.detect = original;
  resolve(await original());
  await status; await f.manager.job;
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.snapshot().installing, false);
}

// Exercise the process wrapper with harmless Node fixtures, never a real installer.
{
  const chunks = [];
  const result = await runEnvironmentInstaller(process.execPath, ['-e', 'console.log("fixture output"); process.exitCode = 7'], { onOutput: output => chunks.push(output) });
  assert.equal(result.code, 7);
  assert.match(result.output, /fixture output/);
  assert.ok(chunks.some(text => text.includes('fixture output')));
  const timedOut = await runEnvironmentInstaller(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 30 });
  assert.equal(timedOut.timedOut, true);
  const missing = await runEnvironmentInstaller('halo-nonexistent-installer-fixture', []);
  assert.equal(missing.code, -1);
  assert.ok(missing.error);
}
console.log('PASS global environment installation: missing-only, single job, verification, failures, cancellation, retries and process wrapper');
