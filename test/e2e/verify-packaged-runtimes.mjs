// Exercise executable/native/WASM dependencies from an extracted release outside
// the checkout so Node cannot accidentally resolve a missing packaged dependency
// from the developer's node_modules directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

assert.ok(process.env.HALO_PACKAGED_EXE, 'Set HALO_PACKAGED_EXE to an extracted application outside the checkout');
const exe = path.resolve(process.env.HALO_PACKAGED_EXE), repository = path.resolve('.');
const relative = path.relative(repository, exe);
assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Packaged runtime smoke must run outside the checkout');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-runtime-smoke-'));
const script = path.join(dir, 'probe.cjs');
const system = process.env.SystemRoot || 'C:/Windows';
const env = {
  SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32', 'cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
  USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'),
  TEMP: dir, TMP: dir, PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PI_OFFLINE: '1',
  ELECTRON_RUN_AS_NODE: '1', WRANGLER_SEND_METRICS: 'false', NO_PROXY: '*',
};
fs.writeFileSync(script, String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const archive = path.join(path.dirname(process.execPath), 'resources', 'app.asar');
const packageRequire = createRequire(path.join(archive, 'package.json'));
const physical = file => {
  const unpacked = file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return fs.existsSync(unpacked) ? unpacked : file;
};
globalThis.fetch = async () => { throw Error('Runtime smoke must stay offline'); };
(async () => {
  const canvas = packageRequire('@napi-rs/canvas').createCanvas(16, 16);
  const context = canvas.getContext('2d');
  context.fillStyle = '#314b83'; context.fillRect(0, 0, 16, 16);
  const bytes = new Uint8Array(canvas.toBuffer('image/png'));
  const pi = await import(pathToFileURL(path.join(archive, 'src/main/pi-runtime.mjs')));
  const piEntry = pi.resolvePiEntry();
  const worker = new Worker(path.join(path.dirname(piEntry), 'utils/image-resize-worker.js'));
  try {
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Image worker timed out')), 15000);
      worker.once('message', message => { clearTimeout(timeout); resolve(message); });
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
      worker.postMessage({ inputBytes: bytes, mimeType: 'image/png', options: { maxWidth: 8, maxHeight: 8 } });
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result?.wasResized, true);
    assert.equal(response.result.width, 8); assert.equal(response.result.height, 8);
  } finally { await worker.terminate(); }
  console.log('PASS packaged native canvas and actual Pi worker/Photon WASM image resize');

  const pty = packageRequire('node-pty');
  let terminal, terminalExited = false;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Native terminal timed out')), 10000);
      let output = '';
      terminal = pty.spawn(process.env.ComSpec, ['/D', '/Q'], {
        name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: true,
      });
      terminal.onData(data => { output += data; if (output.includes('HALO_NATIVE_PTY_OK')) { clearTimeout(timeout); resolve(); } });
      terminal.onExit(() => { terminalExited = true; clearTimeout(timeout); output.includes('HALO_NATIVE_PTY_OK') ? resolve() : reject(Error('Native terminal produced no output')); });
      terminal.write('echo HALO_NATIVE_PTY_OK\r');
    });
  } finally { if (!terminalExited) { try { terminal?.kill(); } catch {} } }
  console.log('PASS packaged node-pty/ConPTY terminal output');

  const cloudflare = await import(pathToFileURL(path.join(archive, 'src/main/cloudflare.mjs')));
  const result = await cloudflare.runWrangler(['--version'], { cwd: process.cwd(), timeout: 15000 });
  assert.equal(result.ok, true, result.errors || result.output);
  assert.match(result.output, /4\.131\.2/);
  for (const owner of [cloudflare.wranglerPath(), physical(packageRequire.resolve('@earendil-works/chord/package.json'))]) {
    const esbuild = createRequire(owner)('esbuild');
    const compiled = await esbuild.transform('const count: number = 2; console.log(count + 3)', { loader: 'ts' });
    assert.ok(compiled.code.includes('count + 3'));
    esbuild.stop();
  }
  console.log('PASS packaged Wrangler CLI and both esbuild runtime owners without global Node');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
`);
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(exe, [script], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => { child.kill(); reject(Error('Packaged runtime smoke timed out')); }, 65000);
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', status => { clearTimeout(timeout); resolve(status); });
  });
  assert.equal(code, 0, 'Packaged native/worker/CLI runtime smoke failed');
} finally {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('halo-runtime-smoke-'));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
