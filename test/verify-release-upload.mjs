import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/upload-release.ps1');
const source = readFileSync(script, 'utf8');
// Cross-platform contract coverage; Windows runs the production script against mock gh below.
assert.match(source, /Test-VerifiedAsset/);
assert.match(source, /state -ceq 'uploaded'/);
assert.match(source, /digest -ieq "sha256:/);
assert.match(source, /size -eq \$Local.size/);
assert.match(source, /Assert-Draft \$release/);
assert.match(source, /\$maxAttempts = 3/);
assert.doesNotMatch(source, /gh release upload \$tag @assets --clobber/);
if (process.platform !== 'win32') {
  console.log('PASS release upload contract; PowerShell scenarios run on Windows');
  process.exit(0);
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'halo-upload-test-'));
const names = ['Pi-Halo-Setup-1.2.3.exe', 'Pi-Halo-Setup-1.2.3.exe.blockmap', 'latest.yml'];
const content = names.map(name => Buffer.from('fixture ' + name));
const assets = names.map((name, i) => ({ name, size: content[i].length, state: 'uploaded',
  digest: 'sha256:' + createHash('sha256').update(content[i]).digest('hex') }));
const report = { version: '1.2.3', assets: names };
for (const [i, key] of ['executable', 'blockmap', 'latest'].entries()) {
  report[key] = { file: names[i], sha256: assets[i].digest.slice(7) };
}
const wrapper = String.raw`
param([string] $ProductionScript)
$ErrorActionPreference = 'Stop'
$script:fixture = Get-Content fixture.json -Raw | ConvertFrom-Json
$script:calls = [Collections.Generic.List[object]]::new()
$script:counts = @{}
$script:reads = 0
$script:created = $false
$script:release = [PSCustomObject]@{ id = 91; tag_name = 'v1.2.3'; draft = $true; assets = @($fixture.assets) }
if ($fixture.published) { $script:release.draft = $false }
function Start-Sleep { param($Seconds) }
function gh {
  $argv = @($args)
  $script:calls.Add($argv)
  $global:LASTEXITCODE = 0
  if ($argv[0] -eq 'api') {
    if ($fixture.metadataFailures -gt 0) {
      $script:fixture.metadataFailures--
      $global:LASTEXITCODE = 1
      return
    }
    if ($argv[-1] -like '*releases?per_page=100') {
      if ($fixture.absent -and -not $script:created) { return '[[]]' }
      if ($fixture.duplicate) { return "[[$($script:release | ConvertTo-Json -Depth 10 -Compress),$($script:release | ConvertTo-Json -Depth 10 -Compress)]]" }
      return "[[$($script:release | ConvertTo-Json -Depth 10 -Compress)]]"
    }
    $script:reads++
    if ($fixture.publishAt -eq $script:reads) { $script:release.draft = $false }
    if ($fixture.corruptAt -eq $script:reads) { $script:release.assets[0].digest = 'sha256:bad' }
    if ($fixture.delayDigest -and $script:counts.ContainsKey($fixture.target) -and $script:reads -ge 4) {
      $script:release.assets = @($script:release.assets | ForEach-Object {
        if ($_.name -eq $fixture.target) { @($fixture.expected | Where-Object name -eq $fixture.target)[0] } else { $_ }
      })
    }
    return ($script:release | ConvertTo-Json -Depth 10 -Compress)
  }
  if ($argv[0] -eq 'release' -and $argv[1] -eq 'create') {
    $script:created = $true
    if ($fixture.createAmbiguous) { $global:LASTEXITCODE = 1 }
    return
  }
  if ($argv[0] -eq 'release' -and $argv[1] -eq 'upload') {
    $name = [IO.Path]::GetFileName($argv[3])
    if (-not $script:counts.ContainsKey($name)) { $script:counts[$name] = 0 }
    $script:counts[$name]++
    if ($fixture.failOnce -eq $name -and $script:counts[$name] -eq 1) { $global:LASTEXITCODE = 1; return }
    if ($fixture.failAlways -eq $name) { $global:LASTEXITCODE = 1; return }
    $asset = @($fixture.expected | Where-Object name -eq $name)[0]
    $asset = $asset | ConvertTo-Json -Compress | ConvertFrom-Json
    if ($fixture.target -eq $name) {
      if ($fixture.badUploadedDigest) { $asset.digest = 'sha256:bad' }
      if ($fixture.noDigest -or $fixture.delayDigest) { $asset.digest = $null }
    }
    $script:release.assets = @($script:release.assets | Where-Object name -ne $name) + @($asset)
    if ($fixture.ambiguous -eq $name) { $global:LASTEXITCODE = 1 }
    return
  }
  throw "Unexpected mock command: $argv"
}
$failure = $null
try { . $ProductionScript } catch { $failure = $_.Exception.Message }
[PSCustomObject]@{ error = $failure; calls = @($script:calls.ToArray()); reads = $script:reads } |
  ConvertTo-Json -Depth 15 | Set-Content -LiteralPath result.json -Encoding UTF8
`;
const scenarios = [];
function scenario(name, extra, verify, setup = () => {}) {
  const cwd = path.join(sandbox, name);
  mkdirSync(path.join(cwd, 'test/results'), { recursive: true });
  mkdirSync(path.join(cwd, 'dist'));
  names.forEach((file, i) => writeFileSync(path.join(cwd, 'dist', file), content[i]));
  writeFileSync(path.join(cwd, 'test/results/release-artifacts.json'), JSON.stringify(report));
  writeFileSync(path.join(cwd, 'fixture.json'), JSON.stringify({ assets, expected: assets, ...extra }));
  writeFileSync(path.join(cwd, 'wrapper.ps1'), wrapper);
  setup(cwd);
  scenarios.push({ name, cwd, verify });
}
function success(result) { assert.equal(result.error, null); }
function uploadNames(result) { return result.uploads.map(call => path.basename(call[3])); }
try {
  scenario('already-verified', {}, result => {
    success(result); assert.deepEqual(result.uploads, []);
  });
  scenario('new-draft', { absent: true, assets: [] }, result => {
    success(result); assert.deepEqual(uploadNames(result), names);
    assert.equal(result.calls.filter(call => call[1] === 'create').length, 1);
    assert.ok(result.uploads.every(call => !call.includes('--clobber')));
  });
  scenario('ambiguous-create', { absent: true, assets: [], createAmbiguous: true }, result => {
    success(result); assert.equal(result.calls.filter(call => call[1] === 'create').length, 1);
  });
  scenario('partial-resume', { assets: assets.slice(0, 2) }, result => {
    success(result); assert.deepEqual(uploadNames(result), ['latest.yml']);
  });
  for (const change of [{ digest: 'sha256:bad' }, { size: 1 }, { state: 'starter' }]) {
    scenario('replace-' + Object.keys(change)[0], { assets: [{ ...assets[0], ...change }, ...assets.slice(1)] }, result => {
      success(result); assert.deepEqual(uploadNames(result), [names[0]]); assert.ok(result.uploads[0].includes('--clobber'));
    });
  }
  scenario('failed-only-retry', { assets: [], failOnce: names[1] }, result => {
    success(result); assert.deepEqual(uploadNames(result), [names[0], names[1], names[1], names[2]]);
  });
  scenario('ambiguous-upload', { assets: assets.slice(1), ambiguous: names[0] }, result => {
    success(result); assert.deepEqual(uploadNames(result), [names[0]]);
  });
  scenario('bounded-failure', { assets: assets.slice(1), failAlways: names[0] }, result => {
    assert.match(result.error, /after 3 attempts/); assert.deepEqual(uploadNames(result), [names[0], names[0], names[0]]);
  });
  scenario('wrong-server-hash', { assets: assets.slice(1), badUploadedDigest: true, target: names[0] }, result => {
    assert.match(result.error, /verification after 3 attempts/); assert.equal(result.uploads.length, 3);
  });
  scenario('missing-digest', { assets: assets.slice(1), noDigest: true, target: names[0] }, result => {
    assert.match(result.error, /not supplied a digest/); assert.equal(result.uploads.length, 1);
  });
  scenario('delayed-digest', { assets: assets.slice(1), delayDigest: true, target: names[0] }, result => {
    success(result); assert.equal(result.uploads.length, 1);
  });
  scenario('published', { published: true }, result => {
    assert.match(result.error, /already published/); assert.deepEqual(result.uploads, []);
  });
  scenario('published-mid-run', { assets: [], publishAt: 2 }, result => {
    assert.match(result.error, /already published/); assert.deepEqual(result.uploads, []);
  });
  scenario('duplicate-release', { duplicate: true }, result => {
    assert.match(result.error, /Duplicate releases/); assert.deepEqual(result.uploads, []);
  });
  scenario('duplicate-asset', { assets: [...assets, assets[0]] }, result => {
    assert.match(result.error, /Duplicate remote assets/); assert.deepEqual(result.uploads, []);
  });
  scenario('metadata-retry', { metadataFailures: 2 }, result => {
    success(result); assert.deepEqual(result.uploads, []);
  });
  scenario('metadata-failed', { metadataFailures: 10 }, result => {
    assert.match(result.error, /Cannot inspect GitHub/); assert.equal(result.calls.length, 3);
  });
  scenario('final-verification', { corruptAt: 2 }, result => {
    assert.match(result.error, /Final remote asset verification/); assert.deepEqual(result.uploads, []);
  });
  scenario('local-tampering', {}, result => {
    assert.match(result.error, /Artifact hash mismatch/); assert.deepEqual(result.calls, []);
  }, cwd => writeFileSync(path.join(cwd, 'dist', names[0]), 'tampered'));
  scenario('report-tampering', {}, result => {
    assert.match(result.error, /exactly the verified/); assert.deepEqual(result.calls, []);
  }, cwd => writeFileSync(path.join(cwd, 'test/results/release-artifacts.json'),
    JSON.stringify({ ...report, assets: [names[0], names[1], '../unverified.exe'] })));

  // One interpreter for all scenarios avoids paying Windows PowerShell cold start 22 times.
  writeFileSync(path.join(sandbox, 'cases.json'), JSON.stringify(scenarios.map(item => item.cwd)));
  writeFileSync(path.join(sandbox, 'batch.ps1'), [
    'param([string] $ProductionScript)',
    "$ErrorActionPreference = 'Stop'",
    'foreach ($case in (Get-Content cases.json -Raw | ConvertFrom-Json)) {',
    '  Push-Location -LiteralPath $case',
    "  try { & (Join-Path $case 'wrapper.ps1') -ProductionScript $ProductionScript } finally { Pop-Location }",
    '}',
  ].join('\n'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(key)));
  Object.assign(env, { RELEASE_TAG: 'v1.2.3', GITHUB_REPOSITORY: 'offline/fixture', GH_CONFIG_DIR: sandbox,
    HOME: sandbox, USERPROFILE: sandbox, APPDATA: sandbox, LOCALAPPDATA: sandbox,
    PSModulePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules') });
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(sandbox, 'batch.ps1'), '-ProductionScript', script],
  { cwd: sandbox, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  for (const item of scenarios) {
    const state = JSON.parse(readFileSync(path.join(item.cwd, 'result.json'), 'utf8').replace(/^\uFEFF/, ''));
    const calls = state.calls ?? [];
    const uploads = calls.filter(call => call[0] === 'release' && call[1] === 'upload');
    for (const call of uploads) {
      assert.equal(call.filter(arg => arg === '--repo').length, 1);
      assert.equal(call.at(-1) === '--clobber' ? call.at(-2) : call.at(-1), 'offline/fixture');
    }
    try { item.verify({ ...state, calls, uploads }); } catch (error) {
      error.message = item.name + ': ' + error.message; throw error;
    }
  }
  console.log('PASS release upload: ' + scenarios.length + ' offline PowerShell scenarios; zero real GitHub calls');
} finally {
  if (path.dirname(path.resolve(sandbox)) !== path.resolve(os.tmpdir()) || !path.basename(sandbox).startsWith('halo-upload-test-')) {
    throw Error('Unsafe test cleanup');
  }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
