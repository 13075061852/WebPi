import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.versions.electron) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-proxy-network-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'),
    [fileURLToPath(import.meta.url), `--user-data-dir=${profile}`], { env, windowsHide:true, stdio:'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, session } = await import('electron');
  const { GlobalProxy } = await import('../../src/main/global-proxy.mjs');
  app.whenReady().then(async () => {
  const servers = [], sockets = new Set();
  const listen = async body => {
    const server = http.createServer((_req, res) => res.end(body)); servers.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  };
  let proxy;
  try {
    const a = await listen('proxy-A'), b = await listen('proxy-B'), origin = await listen('direct');
    const store = { data:{}, set(key, value) { this.data[key] = value; } };
    proxy = new GlobalProxy(store);
    const sessions = [session.defaultSession, session.fromPartition('proxy-preview-fixture')];
    for (const item of sessions) await proxy.addSession(item);
    for (const [port, body] of [[a,'proxy-A'], [b,'proxy-B']]) {
      await proxy.set({ mode:'proxy', port });
      for (const item of sessions) {
        assert.equal(await (await item.fetch('http://proxy-fixture.invalid/')).text(), body);
        assert.match(await item.resolveProxy('https://proxy-fixture.invalid/'), new RegExp(':' + port));
      }
    }
    const late = session.fromPartition('proxy-late-fixture'); await proxy.addSession(late);
    assert.equal(await (await late.fetch('http://proxy-fixture.invalid/')).text(), 'proxy-B');
    await proxy.set({ mode:'direct', port:b });
    for (const item of [...sessions, late]) {
      assert.equal(await item.resolveProxy('https://proxy-fixture.invalid/'), 'DIRECT');
      assert.equal(await (await item.fetch(`http://127.0.0.1:${origin}`)).text(), 'direct');
    }
    console.log('PASS Electron real requests: both proxy ports, default/preview/new sessions and direct reset');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    await proxy?.dispatcher.destroy();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    app.exit(process.exitCode || 0);
  }
  }).catch(error => { console.error(error); app.exit(1); });
}
