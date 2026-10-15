import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnPi } from '../src/main/pi-command.mjs';

// Exercise the injected Windows behavior on every host, without opening a console.
const launcher = fs.readFileSync('src/main/pi-cli.cjs', 'utf8');
for (const platform of ['win32', 'linux']) {
  const calls = [];
  const original = (...args) => { calls.push(args); return 'child'; };
  const childProcess = { spawn: original, spawnSync: original };
  let synced = false;
  vm.runInNewContext(launcher, { process: { platform }, require: name => name === 'node:child_process' ? childProcess : { syncBuiltinESMExports: () => { synced = true; } } });
  for (const name of ['spawn', 'spawnSync']) {
    const options = { cwd: 'C:/fixture', stdio: 'pipe', windowsHide: false };
    assert.equal(childProcess[name]('npm.cmd', ['install', 'literal & text'], options), 'child');
    assert.equal(calls.at(-1)[2].windowsHide, platform === 'win32');
    assert.equal(calls.at(-1)[2].cwd, options.cwd);
    assert.equal(calls.at(-1)[2].stdio, options.stdio);
    assert.deepEqual(calls.at(-1)[1], ['install', 'literal & text']);
    assert.equal(options.windowsHide, false, 'Caller options are not mutated');
    if (platform === 'win32') {
      childProcess[name]('git.exe', { stdio: 'pipe' });
      assert.equal(calls.at(-1)[2].windowsHide, true);
    }
  }
  assert.equal(synced, platform === 'win32');
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-pi-command-'));
try {
  const cliPath = path.join(temp, 'fixture cli.cjs');
  fs.writeFileSync(cliPath, `
    const mode = process.argv[2];
    if (mode === 'hang') {
      console.log('still running');
      setInterval(() => {}, 1000);
    } else if (mode === 'fail') {
      process.stderr.write('missing optional npm or Git');
      process.exitCode = 7;
    } else if (mode === 'long') {
      process.stdout.write('x'.repeat(30000) + '最终输出');
    } else {
      console.log(JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(),
        electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
        proxy: process.env.HTTPS_PROXY,
      }));
    }
  `);
  // No Pi, Node, npm, or Git command is available through PATH in this child.
  const options = { cwd: temp, cliPath, env: { PATH: '', HTTPS_PROXY: 'http://127.0.0.1:12345' } };
  const args = ['install', 'npm:@example/test@1.2.3', 'a path with spaces', 'literal & text'];
  const result = await spawnPi(args, options);
  assert.equal(result.ok, true, result.error || result.output);
  const payload = JSON.parse(result.output);
  assert.deepEqual(payload.args, args);
  assert.equal(payload.cwd, temp);
  assert.equal(payload.electronRunAsNode, '1');
  assert.equal(payload.proxy, options.env.HTTPS_PROXY);

  const failed = await spawnPi(['fail'], options);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 7);
  assert.match(failed.output, /missing optional npm or Git/);
  const long = await spawnPi(['long'], options);
  assert.equal(long.ok, true);
  assert.equal(long.output.length, 1600);
  assert.ok(long.output.endsWith('最终输出'));
  const missing = await spawnPi([], { ...options, executable: path.join(temp, 'missing-runtime.exe') });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ENOENT/);
  const timedOut = await spawnPi(['hang'], { ...options, timeout: 750 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /超时/);
  assert.match(timedOut.output, /still running/);
  console.log('PASS bundled Pi CLI command: no global commands, exact argv, environment, exit, output and timeout');
} finally {
  // Windows can briefly hold the timed-out child's working directory open.
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
