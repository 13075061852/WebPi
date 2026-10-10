// Post-publication, read-only update discovery using the previous real installer.
// This probe never downloads or installs an update and never changes the source tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const from = option('--from'), to = option('--to'), installerArg = option('--installer');
assert.ok(from && to && installerArg, 'Required: --installer <previous EXE> --from <version> --to <version>');
assert.match(from, /^\d+\.\d+\.\d+$/); assert.match(to, /^\d+\.\d+\.\d+$/);
const installer = path.resolve(installerArg);
const expected = parse(fs.readFileSync(path.resolve(option('--manifest') || path.join(root, 'dist/latest.yml')), 'utf8'));
assert.equal(expected.version, to); assert.equal(expected.files?.length, 1);
assert.equal(expected.sha512, expected.files[0].sha512);
assert.ok(fs.statSync(installer).isFile());
const reportPath = path.resolve(option('--report') || path.join(root, 'test/results/public-update-discovery.json'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-public-update-probe-'));
const payloadDir = path.join(dir, 'previous-app');
const run = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sevenZip = path.join(path.dirname(require.resolve('electron-winstaller/package.json')), 'vendor', '7z.exe');
let child, processLog = '';
const started = Date.now();
try {
  const extract = args => run(sevenZip, ['x', '-y', '-bso0', '-bsp0', ...args], { windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  await extract([installer, '-o' + dir, '$PLUGINSDIR\\app-64.7z']);
  await extract([path.join(dir, '$PLUGINSDIR/app-64.7z'), '-o' + payloadDir]);
  const exe = path.join(payloadDir, 'Pi Halo.exe');
  assert.ok(fs.existsSync(exe), 'Previous installer did not contain Pi Halo.exe');
  const configPath = path.join(payloadDir, 'resources/app-update.yml');
  const config = parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.provider, 'github'); assert.equal(config.owner, '13075061852'); assert.equal(config.repo, 'WebPi');
  assert.ok(!config.token && !config.private && !config.requestHeaders, 'Expected an anonymous public GitHub provider');
  const profile = path.join(dir, 'profile'), sdk = path.join(dir, 'pi-sdk.cjs'), resultPath = path.join(dir, 'result.json');
  for (const folder of ['profile', 'roaming', 'local', 'agent', 'gh', 'gcm']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ globalProxy: { mode: 'direct' } }));
  fs.writeFileSync(path.join(dir, 'gitconfig'), '');
  const options = { from, to, expected: expected.files[0], resultPath };
  const probe = String.raw`
exports.initTheme = () => {
  if (globalThis.__haloPublicUpdateProbe) return;
  globalThis.__haloPublicUpdateProbe = true;
  const options = PROBE_OPTIONS;
  const assert = require('node:assert/strict');
  const { createRequire } = require('node:module');
  const { app, BrowserWindow } = require('electron');
  // Hide only this isolated process's windows; there is no reason to show its empty workspace.
  BrowserWindow.prototype.show = function () {};
  for (const window of BrowserWindow.getAllWindows()) window.hide();
  globalThis.fetch = async () => { throw Error('Only the updater metadata session may use the network in this probe'); };
  const timeout = setTimeout(() => { fs.writeFileSync(options.resultPath, JSON.stringify({ pass: false, error: 'Update discovery timed out' })); app.exit(1); }, 90000);
  (async () => {
    await app.whenReady();
    const archive = app.getAppPath();
    assert.ok(archive.endsWith('app.asar'), 'Expected the previous packaged ASAR');
    const oldRequire = createRequire(path.join(archive, 'package.json'));
    const manifest = oldRequire('./package.json');
    assert.equal(manifest.version, options.from); assert.equal(app.getVersion(), options.from); assert.equal(app.isPackaged, true);
    const resolvedUpdater = oldRequire.resolve('electron-updater');
    assert.ok(resolvedUpdater.startsWith(path.dirname(archive) + path.sep), 'Updater must resolve from the previous package');
    const updater = oldRequire('electron-updater').autoUpdater;
    assert.equal(updater.currentVersion.version, options.from);
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false; updater.allowDowngrade = false;
    assert.equal(updater.requestHeaders, null);
    // A trap provides a second guard against any download/install code path.
    updater.downloadUpdate = async () => { throw Error('Update downloads are forbidden in discovery verification'); };
    updater.quitAndInstall = () => { throw Error('Update installation is forbidden in discovery verification'); };
    const requests = [], headersChecked = [];
    const hosts = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
    const netSession = updater.netSession;
    netSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const url = new URL(details.url);
      const blocked = url.protocol !== 'https:' || !hosts.has(url.hostname) || /\.(?:exe|blockmap)(?:$|\/)/i.test(url.pathname);
      requests.push({ host: url.hostname, path: url.pathname, blocked });
      callback({ cancel: blocked });
    });
    netSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const names = Object.keys(details.requestHeaders);
      const authenticated = names.some(name => /^(authorization|cookie)$/i.test(name));
      headersChecked.push({ host: new URL(details.url).hostname, authenticated });
      callback({ cancel: authenticated, requestHeaders: details.requestHeaders });
    });
    let available;
    updater.once('update-available', info => { available = info; });
    updater.on('error', () => {});
    const result = await updater.checkForUpdates();
    assert.equal(result?.updateInfo?.version, options.to);
    assert.equal(available?.version, options.to, 'The previous updater must emit update-available');
    assert.ok(result.downloadPromise == null, 'Discovery must not start downloading');
    assert.equal(result.updateInfo.files?.length, 1);
    const file = result.updateInfo.files[0];
    assert.equal(file.sha512, options.expected.sha512); assert.equal(result.updateInfo.sha512, options.expected.sha512);
    assert.equal(file.size, options.expected.size); assert.equal(file.url, options.expected.url);
    assert.ok(requests.some(item => item.host === 'github.com' && item.path.endsWith('/latest.yml')), 'Must fetch the public update manifest');
    assert.ok(!requests.some(item => item.blocked));
    assert.ok(headersChecked.length > 0 && headersChecked.every(item => !item.authenticated));
    const report = { pass: true, from: manifest.version, to: result.updateInfo.version, updaterVersion: oldRequire('electron-updater/package.json').version,
      provider: { provider: 'github', owner: '13075061852', repo: 'WebPi' }, sha512: file.sha512, installerSize: file.size, installerFile: file.url,
      autoDownload: updater.autoDownload, autoInstallOnAppQuit: updater.autoInstallOnAppQuit, anonymous: true, requests, headersChecked };
    fs.writeFileSync(options.resultPath, JSON.stringify(report, null, 2));
    clearTimeout(timeout); app.exit(0);
  })().catch(error => { fs.writeFileSync(options.resultPath, JSON.stringify({ pass: false, error: error.stack || error.message }, null, 2)); clearTimeout(timeout); app.exit(1); });
};
`;
  fs.writeFileSync(sdk, fs.readFileSync(path.join(root, 'test/fixtures/pi-sdk.js'), 'utf8') + probe.replace('PROBE_OPTIONS', JSON.stringify(options)));
  const system = process.env.SystemRoot || 'C:/Windows';
  const env = {
    SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
    PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
    USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'), TEMP: dir, TMP: dir,
    PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PI_OFFLINE: '1', PI_HALO_PI_PATH: sdk,
    GH_CONFIG_DIR: path.join(dir, 'gh'), GCM_CREDENTIAL_STORE: 'plaintext', GCM_PLAINTEXT_STORE_PATH: path.join(dir, 'gcm'),
    GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', WRANGLER_SEND_METRICS: 'false',
  };
  child = spawn(exe, [`--user-data-dir=${profile}`], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { processLog = (processLog + chunk).slice(-8000); });
  child.on('error', error => { processLog += error.message; });
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(resultPath) && child.exitCode === null && Date.now() < deadline) await sleep(250);
  assert.ok(fs.existsSync(resultPath), `Previous EXE produced no discovery report (exit ${child.exitCode}): ${processLog}`);
  const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const installerDigest = createHash('sha256');
  for await (const chunk of fs.createReadStream(installer)) installerDigest.update(chunk);
  Object.assign(report, { at: new Date().toISOString(), durationMs: Date.now() - started, previousInstaller: installer, previousInstallerSha256: installerDigest.digest('hex') });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  assert.equal(report.pass, true, report.error || 'Public updater discovery failed');
  console.log(`PASS actual packaged updater ${from} -> ${to}; public anonymous feed and SHA-512/size match; no download/install`);
  console.log(`Report: ${reportPath}`);
} finally {
  if (child && child.exitCode === null) { child.kill(); for (let n = 0; n < 30 && child.exitCode === null; n++) await sleep(100); }
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('halo-public-update-probe-'));
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
