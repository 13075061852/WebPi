import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { downloadVerifiedArtifact, ensureUserPath, installOfficialTool, officialInstallAvailable, PINNED_INSTALLERS } from '../src/main/environment-fallback.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-environment-fallback-'));
const calls = [];
const fakePayload = Buffer.from('offline installer fixture; never executed');
const fixtureArtifact = { url: PINNED_INSTALLERS.python.artifacts.x64.url, sha256: createHash('sha256').update(fakePayload).digest('hex') };
let checks = 0;
const mark = () => { checks++; };
const decode = args => Buffer.from(args.at(-1), 'base64').toString('utf16le');
const fixtureEnv = directory => ({ LOCALAPPDATA: directory, SystemRoot: process.env.SystemRoot || 'C:\\Windows', Path: 'C:\\Windows\\System32' });
const noRun = async () => { throw Error('Unexpected process execution'); };

// A tiny, uncompressed ZIP with harmless text entries exercises real Expand-Archive.
function nodeFixtureZip(folder) {
  const locals = [], central = [];
  let offset = 0;
  for (const name of ['node.exe', 'npm.cmd', 'npx.cmd']) {
    const filename = Buffer.from(`${folder}/${name}`);
    const checksum = crc32(fakePayload);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(fakePayload.length, 18); header.writeUInt32LE(fakePayload.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.concat([header, filename, fakePayload]);
    locals.push(entry);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(fakePayload.length, 20); directory.writeUInt32LE(fakePayload.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([directory, filename])); offset += entry.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(3, 8); end.writeUInt16LE(3, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

try {
  // Real streaming/hash implementation, but every response is an in-memory fixture.
  const downloaded = path.join(temporary, 'verified.exe');
  await downloadVerifiedArtifact(fixtureArtifact, downloaded, { fetcher: async (url, options) => {
    assert.equal(url, fixtureArtifact.url); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    return new Response(fakePayload, { headers: { 'content-length': String(fakePayload.length) } });
  } });
  assert.deepEqual(await fs.readFile(downloaded), fakePayload); mark();

  for (const kind of ['hash', 'length', 'http', 'large', 'untrusted-redirect', 'redirect-loop']) {
    const target = path.join(temporary, `${kind}.exe`);
    const fetcher = async () => {
      if (kind === 'http') return new Response('no', { status: 403 });
      if (kind === 'untrusted-redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example/installer.exe' } });
      if (kind === 'redirect-loop') return new Response(null, { status: 302, headers: { location: fixtureArtifact.url } });
      const size = kind === 'large' ? 300 * 1024 * 1024 : kind === 'length' ? fakePayload.length + 1 : fakePayload.length;
      return new Response(fakePayload, { headers: { 'content-length': String(size) } });
    };
    await assert.rejects(downloadVerifiedArtifact(kind === 'hash' ? { ...fixtureArtifact, sha256: '0'.repeat(64) } : fixtureArtifact, target, { fetcher }), error => {
      if (['hash', 'length', 'large'].includes(kind)) assert.equal(error.integrityFailure, true);
      return true;
    });
    await assert.rejects(fs.stat(target), { code: 'ENOENT' }); mark();
  }
  const redirected = path.join(temporary, 'redirected.exe');
  let requests = 0;
  await downloadVerifiedArtifact(fixtureArtifact, redirected, { fetcher: async url => {
    requests++;
    if (requests === 1) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture.exe' } });
    assert.equal(url, 'https://release-assets.githubusercontent.com/fixture.exe');
    return new Response(fakePayload);
  } });
  assert.equal(requests, 2); mark();
  const protectedFile = path.join(temporary, 'existing.exe');
  await fs.writeFile(protectedFile, 'keep');
  await assert.rejects(downloadVerifiedArtifact(fixtureArtifact, protectedFile, { fetcher: async () => new Response(fakePayload) }));
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'keep'); mark();
  await assert.rejects(downloadVerifiedArtifact(fixtureArtifact, path.join(temporary, 'timeout.exe'), { timeout: 10, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })) }), /超时/); mark();

  for (const metadata of Object.values(PINNED_INSTALLERS)) for (const [arch, artifact] of Object.entries(metadata.artifacts)) {
    assert.ok(['x64', 'arm64'].includes(arch)); assert.match(artifact.sha256, /^[0-9a-f]{64}$/); assert.match(artifact.url, /^https:\/\/(www\.python\.org|nodejs\.org|github\.com)\//);
  }
  // The supplied platform and Windows path define this unit-test scenario,
  // independently of the OS running the regression (including Linux CI).
  assert.equal(officialInstallAvailable({ platform: 'win32', arch: 'x64', env: fixtureEnv('C:\\Users\\fixture\\AppData\\Local') }), true);
  assert.equal(officialInstallAvailable({ platform: 'win32', arch: 'arm64', env: fixtureEnv('C:\\Users\\fixture\\AppData\\Local') }), true);
  assert.equal(officialInstallAvailable({ platform: 'win32', arch: 'ia32', env: fixtureEnv(temporary) }), false);
  assert.equal(officialInstallAvailable({ platform: 'win32', arch: 'arm64', env: { LOCALAPPDATA: 'relative' } }), false);
  assert.equal(officialInstallAvailable({ platform: 'linux', arch: 'x64', env: fixtureEnv(temporary) }), false); mark();

  if (process.platform !== 'win32') {
    console.log(`PASS environment fallback: ${checks} portable checks; Windows-only fixture scenarios skipped`);
  } else {
    const download = async (artifact, destination) => {
      assert.ok(Object.values(PINNED_INSTALLERS).some(item => Object.values(item.artifacts).includes(artifact)), 'Install entry points use only pinned metadata');
      calls.push({ type: 'download', url: artifact.url });
      const folder = path.basename(new URL(artifact.url).pathname, '.zip');
      await fs.writeFile(destination, artifact.url.endsWith('.zip') ? nodeFixtureZip(folder) : fakePayload);
    };
    // No real installer or registry mutation is allowed by these process doubles.
    for (const id of ['python', 'git']) for (const arch of ['x64', 'arm64']) {
      const env = fixtureEnv(path.join(temporary, `${id}-${arch}`));
      const result = await installOfficialTool(id, { env, arch, run: async (file, args) => {
        assert.ok(file.startsWith(env.LOCALAPPDATA)); assert.ok(file.endsWith('.exe'));
        assert.deepEqual(await fs.readFile(file), fakePayload);
        if (id === 'python') for (const arg of ['InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=0', 'Include_test=0', '/norestart']) assert.ok(args.includes(arg));
        else for (const arg of ['/CURRENTUSER', '/VERYSILENT', '/NORESTART', '/o:PathOption=Cmd', '/NOCLOSEAPPLICATIONS']) assert.ok(args.includes(arg));
        calls.push({ type: 'installer', id, args }); return { code: 0, output: 'fixture installed' };
      }, download });
      assert.equal(result.code, 0);
      assert.equal((await fs.readdir(path.join(env.LOCALAPPDATA, 'Pi Halo', 'environment'))).length, 0, 'Temporary download removed'); mark();
    }
    for (const [id, code, property] of [['git', 2, 'cancelled'], ['git', 5, 'cancelled'], ['python', 1602, 'cancelled'], ['python', 3010, 'rebootRequired']]) {
      const result = await installOfficialTool(id, { env: fixtureEnv(path.join(temporary, `${id}-${code}`)), arch: 'x64', run: async () => ({ code }), download });
      assert.equal(result[property], true); mark();
    }
    const unsupported = await installOfficialTool('other', { env: fixtureEnv(temporary), run: noRun, download });
    assert.equal(unsupported.code, -1);
    const digestFailure = await installOfficialTool('python', { env: fixtureEnv(path.join(temporary, 'bad-digest')), run: noRun, fetcher: async () => new Response(fakePayload) });
    assert.match(digestFailure.error, /SHA-256/); assert.equal(digestFailure.integrityFailure, true); mark();

    let pathScript;
    const specialDirectory = path.join(temporary, "中文 [工具] '$value");
    await fs.mkdir(specialDirectory);
    const userEnv = fixtureEnv(temporary);
    userEnv.PATH = 'duplicate must disappear';
    const pathResult = await ensureUserPath([specialDirectory], { env: userEnv, run: async (file, args) => {
      assert.equal(path.basename(file).toLowerCase(), 'powershell.exe');
      pathScript = decode(args);
      assert.ok(!pathScript.includes(specialDirectory), 'Directory data is base64 JSON, not executable PowerShell text');
      return { code: 0 };
    } });
    assert.equal(pathResult.code, 0); assert.ok(userEnv.Path.endsWith(specialDirectory)); assert.ok(!Object.hasOwn(userEnv, 'PATH')); mark();
    assert.equal((await ensureUserPath(['relative'], { run: noRun, env: userEnv })).code, -1);
    const before = userEnv.Path;
    assert.equal((await ensureUserPath([specialDirectory], { run: async () => ({ code: 1, output: 'denied' }), env: userEnv })).code, 1);
    assert.equal(userEnv.Path, before); mark();

    // Execute the production PATH script against a fake in-memory RegistryKey only.
    // Notification is disabled; the actual user's registry is never opened or modified.
    const fakeKey = `$fixture = [pscustomobject]@{ Value = '%HALO_PATH_FIXTURE%;;C:\\old;'; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
$fixture | Add-Member ScriptMethod GetValue { param($name, $default, $options) return $this.Value }
$fixture | Add-Member ScriptMethod GetValueNames { return @('Path') }
$fixture | Add-Member ScriptMethod GetValueKind { param($name) return $this.Kind }
$fixture | Add-Member ScriptMethod SetValue { param($name, $value, $kind) $this.Value = $value; $this.Kind = $kind }
$fixture | Add-Member ScriptMethod Dispose { }
$key = $fixture`;
    const isolatedPathScript = pathScript.replace("$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')", fakeKey)
      .replace(/# Notify Explorer[\s\S]*Write-Output 'USER_PATH_UPDATED'/, "Write-Output ($fixture | ConvertTo-Json -Compress)");
    assert.ok(!isolatedPathScript.includes('Registry]::CurrentUser')); assert.ok(!isolatedPathScript.includes('Add-Type'));
    const executeFixture = existing => spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(isolatedPathScript, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, HALO_PATH_FIXTURE: existing }, timeout: 10000 });
    const merged = executeFixture('C:\\first');
    assert.equal(merged.status, 0, merged.stderr);
    const mergedState = JSON.parse(merged.stdout.trim());
    assert.equal(mergedState.Value, `%HALO_PATH_FIXTURE%;;C:\\old;${specialDirectory}`);
    const deduplicated = executeFixture(specialDirectory);
    assert.equal(deduplicated.status, 0, deduplicated.stderr);
    assert.equal(JSON.parse(deduplicated.stdout.trim()).Value, '%HALO_PATH_FIXTURE%;;C:\\old;'); mark();

    for (const arch of ['x64', 'arm64']) {
      const env = fixtureEnv(path.join(temporary, `node ${arch} 中文 [数据]`));
      const folder = `node-v${PINNED_INSTALLERS.node.version}-win-${arch}`;
      let pathWrites = 0;
      const run = async (file, args) => {
        if (file.endsWith('node.exe')) { assert.deepEqual(args, ['--version']); return { code: 0, output: `v${PINNED_INSTALLERS.node.version}` }; }
        const script = decode(args);
        if (script.includes('Expand-Archive')) {
          // The only real process in this install fixture unpacks the tiny local text ZIP.
          assert.ok(script.includes('NODE_ARCHIVE_EXTRACTED'));
          const extracted = spawnSync(file, args, { windowsHide: true, encoding: 'utf8', env: { ...process.env }, timeout: 15000 });
          assert.equal(extracted.status, 0, extracted.stderr);
        } else { assert.ok(script.includes('USER_PATH_UPDATED')); pathWrites++; }
        return { code: 0 };
      };
      assert.equal((await installOfficialTool('node', { env, arch, run, download })).code, 0);
      const target = path.join(env.LOCALAPPDATA, 'Pi Halo', 'environment', folder);
      assert.ok(env.Path.endsWith(target)); assert.equal(pathWrites, 1);
      assert.deepEqual(await fs.readdir(path.dirname(target)), [folder]);
      await fs.writeFile(path.join(target, 'preserve.txt'), 'keep existing runtime');
      assert.equal((await installOfficialTool('node', { env, arch, run, download })).code, 0);
      assert.equal(await fs.readFile(path.join(target, 'preserve.txt'), 'utf8'), 'keep existing runtime'); mark();
      await fs.unlink(path.join(target, 'npm.cmd'));
      const incomplete = await installOfficialTool('node', { env, arch, run, download });
      assert.equal(incomplete.code, -1);
      assert.equal(await fs.readFile(path.join(target, 'preserve.txt'), 'utf8'), 'keep existing runtime'); mark();
    }
    console.log(`PASS environment fallback: ${checks} offline checks; no real installer, external downloads, or user PATH changes`);
  }
} finally {
  const relative = path.relative(os.tmpdir(), temporary);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(temporary, { recursive: true, force: true });
}
