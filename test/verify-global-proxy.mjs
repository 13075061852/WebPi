import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { GlobalProxy, normalizeProxy } from '../src/main/global-proxy.mjs';
import { videoDispatcher } from '../src/main/video-http.mjs';

const savedEnv = { ...process.env }, original = getGlobalDispatcher();
const oldHttp = http.globalAgent, oldHttps = https.globalAgent;
const servers = [], sockets = new Set();
let controller;
const listen = async server => {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};
const get = url => new Promise((resolve, reject) => {
  const request = http.get(url, response => { let body = ''; response.on('data', data => { body += data; }); response.on('end', () => resolve(body)); });
  request.on('error', reject); request.setTimeout(3000, () => request.destroy(Error('timeout')));
});
try {
  const originPort = await listen(http.createServer((_req, res) => res.end('origin')));
  async function proxy(label) {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req.url); res.end(label); });
    server.on('connect', (req, client, head) => {
      seen.push(req.url);
      if (req.url.includes(':443')) { client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); return; }
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
    });
    return { port: await listen(server), seen, label };
  }
  const a = await proxy('A'), b = await proxy('B');
  process.env.http_proxy = `http://127.0.0.1:${a.port}`;
  process.env.npm_config_proxy = process.env.http_proxy;
  const store = { data:{}, set(key, value) { this.data[key] = value; } };
  controller = new GlobalProxy(store);
  assert.equal(await get(`http://127.0.0.1:${originPort}`), 'origin');
  assert.equal(process.env.http_proxy, undefined);
  const browser = { rules:[], async setProxy(value) { this.rules.push(value); }, async closeAllConnections() {} };
  await controller.addSession(browser);
  for (const target of [a, b]) {
    await controller.set({ mode:'proxy', port:target.port });
    assert.equal(await (await fetch(`http://fixture.invalid:${originPort}`, { signal:AbortSignal.timeout(3000) })).text(), 'origin');
    assert.equal(await get(`http://fixture.invalid:${originPort}`), target.label);
    await assert.rejects(fetch('https://fixture.invalid/', { signal:AbortSignal.timeout(3000) }));
    assert.equal(target.seen.length, 3);
    assert.equal(browser.rules.at(-1).mode, 'fixed_servers');
    assert.equal(videoDispatcher('direct'), undefined, 'video must obey global routing');
    assert.equal(process.env.HTTPS_PROXY, `http://127.0.0.1:${target.port}`);
  }
  await controller.set({ mode:'direct', port:b.port });
  assert.equal(await (await fetch(`http://127.0.0.1:${originPort}`)).text(), 'origin');
  assert.equal(await get(`http://127.0.0.1:${originPort}`), 'origin');
  assert.equal(process.env.HTTP_PROXY, undefined);
  assert.equal(process.env.npm_config_proxy, undefined);
  assert.equal(browser.rules.at(-1).mode, 'direct');
  assert.equal(store.data.globalProxy.mode, 'direct');
  for (const port of ['', 0, -1, 65536, 1.5, '123x']) assert.throws(() => normalizeProxy({mode:'proxy', port}));
  browser.setProxy = async value => { if (value.mode === 'fixed_servers') throw Error('fixture failure'); };
  await assert.rejects(controller.set({ mode:'proxy', port:a.port }), /切换失败/);
  assert.equal(controller.state().mode, 'direct');
  assert.equal(store.data.globalProxy.mode, 'direct');
  assert.equal(process.env.HTTP_PROXY, undefined);
  console.log('PASS proxy switching: fetch, native HTTP, HTTPS tunnel, two ports, direct reset, inherited env, video, persistence and rollback');
} finally {
  await controller?.dispatcher.destroy();
  setGlobalDispatcher(original); http.globalAgent = oldHttp; https.globalAgent = oldHttps;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
