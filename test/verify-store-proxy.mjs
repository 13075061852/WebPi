import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { StoreProxy, runStoreProxy } from '../src/main/store-proxy.mjs';

// All process launches and elevation are mocked. Only the Windows PowerShell
// interpreter itself is used to exercise the helper's real control flow.
const disabled = { supported: true, installed: true, enabled: false };
const enabled = { supported: true, installed: true, enabled: true };
const absent = { supported: true, installed: false, enabled: false };
const family = 'Microsoft.WindowsStore_8wekyb3d8bbwe';
const sid = 'S-1-15-2-1609473798-1231923017-684268153-4268514328-882773646-2760585773-1760938157';
let checks = 0;
const mark = () => checks++;

for (const platform of ['linux', 'darwin']) {
  const api = new StoreProxy({ platform, run: async () => assert.fail('Unexpected Windows process') });
  assert.deepEqual(await api.status(), { supported: false, installed: false, enabled: false });
  await assert.rejects(api.repair(), /仅支持 Windows/); mark();
}

for (const before of [absent, enabled]) {
  const calls = [];
  const api = new StoreProxy({ platform: 'win32', run: async action => { calls.push(action); return before; } });
  if (before.installed) assert.deepEqual(await api.repair(), enabled);
  else await assert.rejects(api.repair(), /未安装/);
  assert.deepEqual(calls, ['status'], 'Missing or already configured Store must never request elevation');
  assert.equal(api.job, null); mark();
}

{
  const calls = [];
  let release, configured = false;
  const api = new StoreProxy({ platform: 'win32', run: async action => {
    calls.push(action);
    if (action === 'repair') {
      await new Promise(resolve => { release = resolve; });
      configured = true;
    }
    return configured ? enabled : disabled;
  } });
  const first = api.repair();
  assert.equal(api.repair(), first, 'Repeated clicks must share the repair job');
  const reading = api.status();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['status', 'repair'], 'Status during repair waits instead of displaying stale disabled state');
  release();
  assert.deepEqual(await first, enabled);
  assert.deepEqual(await reading, enabled);
  assert.deepEqual(calls, ['status', 'repair', 'status']);
  assert.equal(api.job, null); mark();
}

for (const kind of ['repair-error', 'post-read-error', 'post-read-disabled', 'post-read-absent']) {
  let reads = 0, failure = true;
  const api = new StoreProxy({ platform: 'win32', run: async action => {
    if (action === 'repair') {
      if (failure && kind === 'repair-error') throw Error('fixture permission failure');
      return enabled;
    }
    reads++;
    if (!failure) return enabled;
    if (reads === 1) return disabled;
    if (kind === 'post-read-error') throw Error('fixture read failure');
    return kind === 'post-read-absent' ? absent : disabled;
  } });
  await assert.rejects(api.repair());
  assert.equal(api.job, null, 'Failure must release the lock for retry');
  failure = false;
  assert.deepEqual(await api.repair(), enabled); mark();
}

function fakeProcess(onRequest) {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.kills = (child.kills || 0) + 1; return true; };
    let input = '';
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { input += chunk; callback(); },
      final(callback) { callback(); queueMicrotask(() => onRequest(child, JSON.parse(input))); },
    });
    calls.push({ executable, args, options, child });
    return child;
  };
  return { spawnProcess, calls };
}
function respond(child, value, code = 0) {
  child.stdout.end(value);
  child.emit('close', code);
}

{
  const fixture = fakeProcess((child, request) => {
    assert.deepEqual(request, { action: 'status' });
    respond(child, '\uFEFF' + JSON.stringify(enabled));
  });
  assert.deepEqual(await runStoreProxy('status', { ...fixture, env: { SystemRoot: 'C:\\Fixture Windows' } }), enabled);
  const call = fixture.calls[0];
  assert.equal(call.executable, path.join('C:\\Fixture Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(call.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.ok(call.args.at(-1).endsWith('store-proxy.ps1'));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']); mark();
}
await assert.rejects(runStoreProxy('arbitrary-command', { spawnProcess: () => assert.fail('Invalid action spawned a process') }), /不支持/); mark();

for (const value of ['not json', 'null', '[]', 'true', '5', '{}', JSON.stringify({ ...enabled, supported: false }), JSON.stringify({ ...absent, enabled: true })]) {
  const fixture = fakeProcess(child => respond(child, value));
  await assert.rejects(runStoreProxy('status', fixture)); mark();
}
for (const code of ['cancelled', 'not-installed', 'verify-failed', 'read-failed', 'repair-failed', 'tool-unavailable', 'unexpected']) {
  const fixture = fakeProcess(child => respond(child, JSON.stringify({ error: code }), 1));
  await assert.rejects(runStoreProxy('repair', fixture), error => {
    assert.doesNotMatch(error.message, /Error:|at |fixture-secret/);
    if (code === 'cancelled') assert.match(error.message, /已取消管理员授权/);
    return true;
  }); mark();
}
{
  const fixture = fakeProcess(child => respond(child, JSON.stringify(enabled), 1));
  await assert.rejects(runStoreProxy('status', fixture), /无法验证/); mark();
}
{
  const fixture = fakeProcess(child => child.stdout.write('x'.repeat(65537)));
  await assert.rejects(runStoreProxy('status', fixture), /返回内容异常/);
  assert.equal(fixture.calls[0].child.kills, 1); mark();
}
for (const action of ['status', 'repair']) {
  const fixture = fakeProcess(() => {});
  await assert.rejects(runStoreProxy(action, { ...fixture, timeout: 5 }), /超时/);
  assert.equal(fixture.calls[0].child.kills, 1);
  respond(fixture.calls[0].child, JSON.stringify(enabled)); mark();
}
await assert.rejects(runStoreProxy('status', { spawnProcess: () => { throw Error('fixture'); } }), /无法启动/); mark();
{
  const fixture = fakeProcess(child => child.emit('error', Error('fixture-secret')));
  await assert.rejects(runStoreProxy('status', fixture), /无法启动/); mark();
}

if (process.platform === 'win32') {
  const source = readFileSync(new URL('../src/main/store-proxy.ps1', import.meta.url), 'utf8');
  const toolAssignment = /^\$tool = Join-Path[^\r\n]+$/m;
  assert.equal((source.match(new RegExp(toolAssignment.source, 'gm')) || []).length, 1);
  assert.equal((source.match(/\bexit 1\b/g) || []).length, 1);
  // Rewrite only the native tool target and exit so the test harness can retain
  // telemetry. All actual command/function calls below resolve to fixture mocks.
  const helper = source.replace(toolAssignment, "$tool = 'Invoke-FixtureIsolation'").replace(/\bexit 1\b/, '$global:FixtureExitCode = 1; return');
  const scenarios = [
    { name: 'english-name', listing: `Name: ${family.toLowerCase()}`, result: enabled, reads: 1 },
    { name: 'localized-sid', listing: `名称: 无法解析应用名称\nSID: ${sid}`, result: enabled, reads: 1 },
    { name: 'prefix-collision', listing: `Name: ${family}.Other\nSID: ${sid}1`, result: disabled, reads: 1 },
    { name: 'empty-list', listing: '列出回送豁免的 AppContainer\n确定。', result: disabled, reads: 1 },
    { name: 'not-installed', installed: false, result: absent, reads: 0 },
    { name: 'tool-missing', toolMissing: true, error: 'tool-unavailable', reads: 0 },
    { name: 'query-failure', queryFailure: true, listing: family, error: 'read-failed', reads: 1 },
    { name: 'appx-failure', appxFailure: true, error: 'read-failed', reads: 0 },
    { name: 'no-op-repair', action: 'repair', listing: family, result: enabled, reads: 1 },
    { name: 'missing-repair', action: 'repair', installed: false, error: 'not-installed', reads: 0 },
    { name: 'successful-repair', action: 'repair', after: sid, result: enabled, reads: 2, starts: 1 },
    { name: 'cancelled-repair', action: 'repair', cancel: true, error: 'cancelled', reads: 1, starts: 1 },
    { name: 'cancelled-native-exit', action: 'repair', exitCode: 1223, error: 'cancelled', reads: 1, starts: 1 },
    { name: 'failed-repair', action: 'repair', exitCode: 5, error: 'repair-failed', reads: 1, starts: 1 },
    { name: 'post-read-failure', action: 'repair', error: 'verify-failed', reads: 2, starts: 1 },
    { name: 'invalid-action', action: 'arbitrary-command', error: 'read-failed', reads: 0 },
  ];
  for (const scenario of scenarios) {
    const encodedFixture = Buffer.from(JSON.stringify(scenario)).toString('base64');
    const fixture = `
$global:Fixture = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFixture}')) | ConvertFrom-Json
$global:FixtureReads = 0
$global:FixtureStarts = 0
$global:FixtureExitCode = 0
function Get-AppxPackage {
  param($Name, $ErrorAction)
  if ($Name -ne 'Microsoft.WindowsStore') { throw 'Wrong package query' }
  if ($global:Fixture.appxFailure) { throw 'fixture AppX access failure' }
  if ($global:Fixture.installed -eq $false) { return }
  [pscustomobject]@{ PackageFamilyName = '${family}' }
}
function Test-Path {
  param($LiteralPath, $PathType)
  if ($LiteralPath -ne 'Invoke-FixtureIsolation' -or $PathType -ne 'Leaf') { throw 'Unsafe path query' }
  return !$global:Fixture.toolMissing
}
function Invoke-FixtureIsolation {
  if (($args -join '|') -ne 'LoopbackExempt|-s') { throw 'Unsafe native command' }
  $global:FixtureReads++
  $global:LASTEXITCODE = if ($global:Fixture.queryFailure) { 5 } else { 0 }
  if ($global:FixtureStarts -gt 0) { [string]$global:Fixture.after } else { [string]$global:Fixture.listing }
}
function Start-Process {
  param($FilePath, [string[]]$ArgumentList, $Verb, $WindowStyle, [switch]$Wait, [switch]$PassThru)
  $global:FixtureStarts++
  if ($FilePath -ne 'Invoke-FixtureIsolation' -or ($ArgumentList -join '|') -ne 'LoopbackExempt|-a|-n=${family}' -or $Verb -ne 'RunAs' -or $WindowStyle -ne 'Hidden' -or !$Wait -or !$PassThru) { throw 'Unsafe elevation request' }
  if ($global:Fixture.cancel) { throw [System.InvalidOperationException]::new('wrapped cancellation', [System.ComponentModel.Win32Exception]::new(1223)) }
  [pscustomobject]@{ ExitCode = [int]$global:Fixture.exitCode }
}
& {
${helper}
}
@{ fixtureReads = $global:FixtureReads; fixtureStarts = $global:FixtureStarts; fixtureExitCode = $global:FixtureExitCode } | ConvertTo-Json -Compress
`;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(fixture, 'utf16le').toString('base64')], {
      input: JSON.stringify({ action: scenario.action || 'status' }), encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
    const lines = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, '')));
    assert.equal(lines.length, 2, scenario.name);
    assert.deepEqual(lines[0], scenario.error ? { error: scenario.error } : scenario.result, scenario.name);
    assert.deepEqual(lines[1], { fixtureReads: scenario.reads, fixtureStarts: scenario.starts || 0, fixtureExitCode: scenario.error ? 1 : 0 }, scenario.name);
    mark();
  }
}

console.log(`PASS Store proxy: ${checks} offline checks; no real exemptions, elevation or account changes`);
