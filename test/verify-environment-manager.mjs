import assert from 'node:assert/strict';
import { EnvironmentManager, installArguments, installerFailure, supportsWinGetProxy, runEnvironmentInstaller } from '../src/main/environment-manager.mjs';

const ids = ['python', 'node', 'git'];
function fixture(initial = [], installerAvailable = true, extra = {}) {
  const installed = new Set(initial), calls = [], changes = [];
  let refreshed = 0, response = { code: 0 }, apply = true;
  const manager = new EnvironmentManager({
    env: {}, fallbackAvailable: () => false,
    fallback: async () => assert.fail('Unexpected official installer'),
    repairPath: async () => assert.fail('Unexpected PATH change'),
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
    ...extra,
  });
  return { manager, installed, calls, changes, refreshed: () => refreshed,
    fail: result => { response = result; apply = false; }, succeed: () => { response = { code: 0 }; apply = true; } };
}

// Fixed package IDs; user installations avoid requiring an administrator for Python/Git.
for (const id of ids) {
  const args = installArguments(id, {});
  assert.equal(args[args.indexOf('--scope') + 1], id === 'node' ? 'machine' : 'user');
  assert.ok(!args.includes('--no-upgrade'));
  assert.ok(!args.includes('--disable-interactivity'), 'Support old WinGet versions');
  assert.equal(args[args.indexOf('--source') + 1], 'winget');
}
assert.throws(() => installArguments('arbitrary-package'), /不支持/);
assert.match(installArguments('python', {})[installArguments('python', {}).indexOf('--override') + 1], /InstallAllUsers=0.*Include_launcher=0/);
assert.deepEqual(installArguments('git', { HTTPS_PROXY: 'http://127.0.0.1:38471' }, { version: '1.8.1791' }).slice(-2), ['--proxy', 'http://127.0.0.1:38471']);
assert.ok(!installArguments('git', { HTTPS_PROXY: 'http://127.0.0.1:38471' }, { version: '1.7.0' }).includes('--proxy'));
for (const version of ['', undefined, 'unknown', '1.7.11261']) assert.equal(supportsWinGetProxy(version), false);
for (const version of ['1.8.0', 'v1.12.0', '2.0.0']) assert.equal(supportsWinGetProxy(version), true);
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
  assert.equal(f.refreshed(), 4);
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

// Missing WinGet is supported without installing WinGet/Store or touching healthy tools.
{
  const fallbackCalls = [];
  const f = fixture(['git'], false, {
    fallbackAvailable: () => true,
    fallback: async (id, options) => { fallbackCalls.push(id); options.onOutput('Official fixture'); f.installed.add(id); return { code: 0 }; },
  });
  assert.equal((await f.manager.status()).installer.automaticAvailable, true);
  f.manager.start(); await f.manager.job;
  assert.deepEqual(fallbackCalls, ['python', 'node']);
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.snapshot().progress.at(-1).state, 'done');
}

// Node's official ZIP avoids the machine-only MSI; old WinGet cannot receive --proxy.
for (const initial of [['python', 'git'], ['node']]) {
  const fallbackCalls = [];
  const f = fixture(initial, true, {
    env: { HTTPS_PROXY: 'http://127.0.0.1:38471' },
    fallbackAvailable: () => true,
    fallback: async id => { fallbackCalls.push(id); f.installed.add(id); return { code: 0 }; },
  });
  const original = f.manager.detect;
  f.manager.detect = async () => { const value = await original(); value.installer.version = '1.7.0'; return value; };
  f.manager.start(); await f.manager.job;
  assert.deepEqual(fallbackCalls, ids.filter(id => !initial.includes(id)));
  assert.equal(f.calls.length, 0, 'No unsupported flag or UAC prompt should be launched');
}

// A source/network/no-applicable-installer failure can use the official fallback.
for (const code of [0x8a15000f, 0x8a150010, 0x8a150008]) {
  const fallbacks = [];
  const f = fixture(['node', 'git'], true, {
    fallbackAvailable: () => true,
    fallback: async id => { fallbacks.push(id); f.installed.add(id); return { code: 0 }; },
  });
  f.fail({ code: code | 0, output: 'Unavailable source fixture' });
  f.manager.start(); await f.manager.job;
  assert.deepEqual(fallbacks, ['python']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.manager.snapshot().progress.at(-1).state, 'done');
}

// Explicit PATH repair must use the detected runtime, never download a duplicate.
{
  const repairs = [];
  const f = fixture(['node', 'git'], true, {
    fallbackAvailable: () => true,
    repairPath: async dirs => { repairs.push(dirs); f.installed.add('python'); return { code: 0 }; },
  });
  const original = f.manager.detect;
  f.manager.detect = async () => {
    const value = await original();
    if (!f.installed.has('python')) Object.assign(value.tools[0], { problem: 'path', path: 'C:\\Python\\python.exe', repairPaths: ['C:\\Python', 'C:\\Python\\Scripts'] });
    return value;
  };
  f.manager.start(); await f.manager.job;
  assert.deepEqual(repairs, [['C:\\Python', 'C:\\Python\\Scripts']]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.snapshot().tools[0].installed, true);
}

// Failure/partial PATH writes do not cause reinstalling an already located runtime.
{
  const f = fixture(['node', 'git'], true, { repairPath: async () => ({ code: 0 }) });
  const original = f.manager.detect;
  f.manager.detect = async () => { const value = await original(); Object.assign(value.tools[0], { problem: 'path', repairPaths: ['C:\\Python'] }); return value; };
  f.manager.start(); await f.manager.job;
  assert.equal(f.calls.length, 0);
  assert.match(f.manager.snapshot().progress.find(p => p.id === 'python' && p.state === 'error').message, /PATH/);
}

// Never retry past cancellation, policy, tampered downloads, busy installers or reboot.
for (const code of [0x800704c7, 0x8a15010c, 0x8a150005, 1602, 3010, 1641, 0x80070bc2, 0x8a150109, 0x8a15010a, 0x8a15010b, 0x8a150011, 0x8a15002d, 0x8a15003a, 0x8a15010f, 1625, 1618, 0x8a150102, 0x8a150105, 0x8a150113]) {
  const f = fixture([], true, { fallbackAvailable: () => true });
  f.fail({ code: code | 0, output: 'Stopped fixture https://user:secret@example.com' });
  f.manager.start(); await f.manager.job;
  assert.equal(f.calls.length, 1, `Stopped after ${code.toString(16)}`);
  assert.equal(installerFailure({ code: code | 0 }).stop, true);
  assert.doesNotMatch(JSON.stringify(f.manager.snapshot()), /secret/);
}
for (const result of [{ code: -1, integrityFailure: true }, { code: -1, timedOut: true }, { code: 0, rebootRequired: true }, { code: 5, cancelled: true }]) {
  let calls = 0;
  const f = fixture([], false, { fallbackAvailable: () => true, fallback: async () => { calls++; return result; } });
  f.manager.start(); await f.manager.job;
  assert.equal(calls, 1);
  assert.equal(f.manager.snapshot().progress.at(-1).state, 'error');
}

// Every stage honors injected environments; tests must never fall through to host PATH.
{
  const env = { Path: 'C:\\Fixture' }, optionsSeen = [];
  const f = fixture(ids, false, { env, detect: async options => { optionsSeen.push(options); return { platform: 'win32', installer: { available: false }, tools: ids.map(id => ({ id, installed: true })) }; } });
  await f.manager.status(); f.manager.start(); await f.manager.job;
  assert.ok(optionsSeen.length >= 2);
  assert.ok(optionsSeen.every(options => options.env === env));
}

// One throwing tool should not prevent unrelated missing tools from being configured.
{
  const f = fixture([], false, { fallbackAvailable: () => true,
    fallback: async id => { if (id === 'python') throw Error('download fixture failed'); f.installed.add(id); return { code: 0 }; },
  });
  f.manager.start(); await f.manager.job;
  assert.deepEqual([...f.installed], ['node', 'git']);
  assert.equal(f.manager.snapshot().progress.at(-1).state, 'error');
}

// A zero exit code must not start another installer if the new runtime is not usable.
{
  const f = fixture(['node', 'git'], true, { fallbackAvailable: () => true });
  f.fail({ code: 0 }); f.manager.start(); await f.manager.job;
  assert.equal(f.calls.length, 1);
  assert.equal(f.manager.snapshot().progress.at(-1).state, 'error');
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
console.log('PASS environment configuration: current-user fallback, old WinGet/proxy, PATH repair, missing-only, single job, verification, cancellation/policy/integrity/reboot, retries and process wrapper');
