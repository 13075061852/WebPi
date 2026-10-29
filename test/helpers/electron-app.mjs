import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function waitUntil(fn, message) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw Error(message);
}
export async function launchElectronApp({ fixture, profile, env }) {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const packaged = process.env.HALO_PACKAGED_EXE;
  const exe = packaged || path.resolve(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron');
  const child = spawn(exe, [...(packaged ? [] : ['.']), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false, output = '', ws, sequence = 0, page;
  child.on('exit', () => { exited = true; }); child.on('error', error => { output += error.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-20000); });
  const stop = async () => {
    ws?.close(); if (!exited) child.kill();
    await waitUntil(() => exited, 'Fixture did not stop'); fs.appendFileSync(path.join(fixture, 'process.log'), output);
  };
  try {
    await waitUntil(async () => {
      if (exited) throw Error(output);
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page' && p.url.endsWith('index.html')); } catch {}
      return page;
    }, 'Main page missing');
    ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
    const pending = new Map(), errors = [];
    ws.addEventListener('message', event => {
      const response = JSON.parse(event.data);
      if (response.method === 'Runtime.exceptionThrown') errors.push(response.params.exceptionDetails);
      pending.get(response.id)?.(response); pending.delete(response.id);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)); }, 10000);
      pending.set(id, response => { clearTimeout(timer); resolve(response); }); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.result?.exceptionDetails) throw Error(JSON.stringify(response.result.exceptionDetails));
      return response.result?.result?.value;
    };
    await send('Runtime.enable');
    await waitUntil(async () => (await evaluate('window.halo?.startupState().then(r=>r.data)'))?.ready, 'Startup incomplete');
    const close = async () => {
      if (errors.length) throw Error(JSON.stringify(errors));
      await evaluate('setTimeout(()=>window.halo.close(),30);true'); await waitUntil(() => exited, 'Application did not quit normally'); await stop();
    };
    return { send, evaluate, close, stop };
  } catch (error) { await stop(); throw error; }
}
