import assert from 'node:assert/strict';
import { detectEnvironment, refreshProcessPath } from '../src/main/environment-detection.mjs';

const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const windowsKey = (value) => value.replace(/\//g, '\\').toLowerCase();

function windowsFixture({ env = {}, files = {}, persisted = {} } = {}) {
  const runs = [];
  const executables = new Map(Object.entries(files).map(([file, result]) => [windowsKey(file), result]));
  executables.set(windowsKey(powershell), { code: 0, stdout: JSON.stringify(persisted) });
  const options = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local', Path: '', ...env },
    exists: (file) => executables.has(windowsKey(file)),
    run: async (file, args, commandOptions) => {
      runs.push({ file, args, env: commandOptions.env });
      const result = executables.get(windowsKey(file));
      assert.ok(result, `Unexpected executable: ${file}`);
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(args) : result;
    },
  };
  return { options, runs };
}

// Persisted PATH is picked up even if this Electron process was started before installation.
{
  const pythonPath = 'C:\\Users\\Test\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';
  const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
  const gitPath = 'C:\\Program Files\\Git\\cmd\\git.exe';
  const wingetPath = 'C:\\Users\\Test\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe';
  const fixture = windowsFixture({
    env: { Path: 'C:\\Custom Tools;C:\\Windows' },
    persisted: { machine: 'C:\\Windows;C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd', user: '%LOCALAPPDATA%\\Programs\\Python\\Python314;%LOCALAPPDATA%\\Microsoft\\WindowsApps' },
    files: {
      [pythonPath]: (args) => {
        assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
        return { code: 0, stdout: JSON.stringify({ version: '3.14.3', path: pythonPath }) };
      },
      [nodePath]: { code: 0, stdout: 'v24.14.0\r\n' },
      [gitPath]: { code: 0, stdout: 'git version 2.53.0.windows.1\n' },
      [wingetPath]: { code: 0, stdout: 'v1.12.470\n' },
    },
  });
  const original = { ...fixture.options.env };
  const result = await detectEnvironment(fixture.options);
  assert.deepEqual(result.tools.map(({ id, installed, version, path }) => ({ id, installed, version, path })), [
    { id: 'python', installed: true, version: '3.14.3', path: pythonPath },
    { id: 'node', installed: true, version: '24.14.0', path: nodePath },
    { id: 'git', installed: true, version: '2.53.0.windows.1', path: gitPath },
  ]);
  assert.deepEqual(result.installer, { name: 'WinGet', available: true, path: wingetPath, version: '1.12.470' });
  assert.ok(!Number.isNaN(Date.parse(result.updatedAt)));
  assert.deepEqual(fixture.options.env, original, 'Read-only detection must not mutate environment');
  const merged = await refreshProcessPath(fixture.options);
  assert.ok(merged.startsWith('C:\\Custom Tools;C:\\Windows;'), 'Preserve explicit inherited PATH directories');
  assert.equal(merged.split(';').filter((value) => value.toLowerCase() === 'c:\\windows').length, 1);
  assert.ok(merged.includes('C:\\Users\\Test\\AppData\\Local\\Programs\\Python\\Python314'));
  assert.equal(fixture.options.env.Path, merged);
}

// Store's python alias must not launch; py -3 can locate a real installed interpreter.
{
  const aliases = 'C:\\Users\\Test\\AppData\\Local\\Microsoft\\WindowsApps';
  const pythonPath = 'C:\\Python314\\python.exe';
  const fixture = windowsFixture({
    env: { Path: `${aliases};C:\\Windows` },
    files: {
      [`${aliases}\\python.exe`]: () => assert.fail('Microsoft Store alias was executed'),
      [`${aliases}\\python3.exe`]: () => assert.fail('Microsoft Store alias was executed'),
      'C:\\Windows\\py.exe': (args) => {
        assert.deepEqual(args.slice(0, 3), ['-3', '-I', '-c']);
        return { code: 0, stdout: JSON.stringify({ version: '3.14.3', path: pythonPath }) };
      },
      [pythonPath]: { code: 0, stdout: '' },
    },
  });
  const result = await detectEnvironment(fixture.options);
  assert.equal(result.tools[0].installed, true);
  assert.equal(result.tools[0].path, pythonPath);
  assert.equal(result.installer.available, false);
  assert.ok(result.installer.helpUrl.startsWith('https://learn.microsoft.com/'));
}

// Bundled/private Node does not satisfy global installation; neither do relative PATH entries.
{
  const fixture = windowsFixture({
    env: { Path: 'C:\\Users\\Test\\.codex\\runtime;C:\\Halo\\node_modules\\node\\bin;C:\\Halo\\resources\\app.asar.unpacked\\runtime;.;tools;C:\\PrivateTools' },
    files: {
      'C:\\Users\\Test\\.codex\\runtime\\node.exe': () => assert.fail('Codex private runtime was executed'),
      'C:\\Halo\\node_modules\\node\\bin\\node.exe': () => assert.fail('Bundled Node was executed'),
      'C:\\Halo\\resources\\app.asar.unpacked\\runtime\\node.exe': () => assert.fail('Bundled Node was executed'),
      'C:\\PrivateTools\\node.exe': () => assert.fail('Explicit excluded path was executed'),
      'tools\\node.exe': () => assert.fail('Relative executable was executed'),
    },
  });
  fixture.options.excludedDirectories = ['C:\\PrivateTools'];
  const result = await detectEnvironment(fixture.options);
  assert.deepEqual(result.tools.map((tool) => tool.installed), [false, false, false]);
  assert.equal(fixture.runs.length, 1, 'Only the persisted PATH probe should run');
}

// Broken commands/invalid output do not pretend to be installed, and later valid paths work.
{
  const fixture = windowsFixture({
    env: { Path: 'C:\\Broken;C:\\Good' },
    files: {
      'C:\\Broken\\python.exe': { code: 0, stdout: JSON.stringify({ version: '2.7.18', path: 'C:\\Broken\\python.exe' }) },
      'C:\\Broken\\node.exe': new Error('mock spawn failure'),
      'C:\\Broken\\git.exe': { code: -1, stdout: '', error: 'timeout' },
      'C:\\Broken\\winget.exe': { code: 0, stdout: 'This application is not available' },
      'C:\\Good\\node.exe': { code: 0, stdout: 'v18.20.8\n' },
      'C:\\Good\\git.exe': { code: 0, stdout: 'git version 2.49.0.windows.1\n' },
    },
  });
  const result = await detectEnvironment(fixture.options);
  assert.equal(result.tools[0].installed, false, 'Python 2 is not usable Python 3');
  assert.match(result.tools[0].error, /无法正常运行/);
  assert.equal(result.tools[1].version, '18.20.8', 'Detection must report older installed versions without upgrading');
  assert.equal(result.tools[2].installed, true);
  assert.equal(result.installer.available, false);
}

// A broken registry/Powershell lookup must not prevent PATH-based tools from being detected.
{
  const fixture = windowsFixture({
    env: { Path: 'C:\\Tools' },
    files: { 'C:\\Tools\\node.exe': { code: 0, stdout: 'v22.19.0' } },
  });
  const originalRun = fixture.options.run;
  fixture.options.run = (file, ...rest) => file === powershell ? Promise.reject(new Error('blocked')) : originalRun(file, ...rest);
  const result = await detectEnvironment(fixture.options);
  assert.equal(result.tools[1].installed, true);
}

// POSIX detection remains read-only and explains the unavailable Windows installer.
{
  const files = new Map([
    ['/usr/local/bin/python3', { code: 0, stdout: JSON.stringify({ version: '3.13.5', path: '/usr/local/bin/python3' }) }],
    ['/usr/local/bin/node', { code: 0, stdout: 'v24.1.0' }],
    ['/usr/local/bin/git', { code: 0, stdout: 'git version 2.49.0' }],
  ]);
  const result = await detectEnvironment({
    platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' },
    exists: (file) => files.has(file),
    run: async (file) => {
      assert.ok(files.has(file));
      return files.get(file);
    },
  });
  assert.deepEqual(result.tools.map((tool) => tool.installed), [true, true, true]);
  assert.equal(result.installer.available, false);
  assert.match(result.installer.error, /Windows/);
}

console.log('PASS environment detection: persisted PATH, Python launcher/aliases, runtime isolation, failures and platforms');
