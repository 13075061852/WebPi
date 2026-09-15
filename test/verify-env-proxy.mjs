import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { configureEnvironmentProxy } from '../src/main/env-proxy.mjs';

// Exercise global fetch, which the OAuth SDK uses. All destinations and
// proxies are local fixtures on OS-assigned ports; no accounts or network needed.
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const savedEnvironment = new Map(proxyKeys.map(key => [key, process.env[key]]));
const originalDispatcher = getGlobalDispatcher();
const installedGlobals = ['fetch', 'Headers', 'Response', 'Request', 'FormData',
  'WebSocket', 'CloseEvent', 'ErrorEvent', 'MessageEvent', 'EventSource'];
const savedGlobals = new Map(installedGlobals
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const agents = [];
const servers = [];
const sockets = new Set();
let originRequests = 0;
let directHttpsConnections = 0;

function trackSocket(socket) {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  return socket;
}

async function listen(server) {
  servers.push(server);
  server.on('connection', trackSocket);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `127.0.0.1:${server.address().port}`;
}

function configure(env) {
  const agent = configureEnvironmentProxy(env);
  assert.ok(agent, 'configured proxy must install a dispatcher');
  assert.equal(getGlobalDispatcher(), agent);
  agents.push(agent);
  return agent;
}

async function fetchBody(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.text();
}

try {
  for (const key of proxyKeys) delete process.env[key];
  assert.equal(configureEnvironmentProxy({}), null);
  assert.equal(getGlobalDispatcher(), originalDispatcher,
    'an unconfigured environment must preserve the existing dispatcher');

  const origin = await listen(http.createServer((request, response) => {
    originRequests++;
    if (request.url === '/oauth-gzip-fixture') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      response.end(gzipSync(JSON.stringify({ token: 'fixture-only', message: '压缩响应' })));
      return;
    }
    response.end('local origin');
  }));
  // A direct HTTPS attempt reaches this controlled sink. Proxies reject its
  // CONNECT request deliberately, proving HTTPS routing without TLS fixtures.
  const httpsOrigin = await listen(net.createServer(socket => {
    directHttpsConnections++;
    socket.destroy();
  }));
  const httpUrl = `http://${origin}/oauth-fixture`;
  const httpsUrl = `https://${httpsOrigin}/oauth-fixture`;

  async function createProxy() {
    const connections = [];
    const server = http.createServer((_request, response) => {
      response.writeHead(502).end();
    });
    server.on('connect', (request, client, head) => {
      connections.push(request.url);
      if (request.url !== origin) {
        client.end('HTTP/1.1 502 Fixture rejection\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = trackSocket(net.connect({
        host: '127.0.0.1', port: Number(origin.split(':')[1]),
      }));
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.once('close', () => upstream.destroy());
      upstream.once('error', () => client.destroy());
    });
    return { url: `http://${await listen(server)}`, connections };
  }
  const first = await createProxy();
  const second = await createProxy();

  async function assertRoutes(env, expectedHttpProxy, expectedHttpsProxy) {
    const firstCount = first.connections.length;
    const secondCount = second.connections.length;
    configure(env);
    assert.equal(await fetchBody(httpUrl), 'local origin');
    await assert.rejects(fetch(httpsUrl, { signal: AbortSignal.timeout(3000) }));
    assert.deepEqual(first.connections.slice(firstCount), [
      ...(expectedHttpProxy === first ? [origin] : []),
      ...(expectedHttpsProxy === first ? [httpsOrigin] : []),
    ]);
    assert.deepEqual(second.connections.slice(secondCount), [
      ...(expectedHttpProxy === second ? [origin] : []),
      ...(expectedHttpsProxy === second ? [httpsOrigin] : []),
    ]);
    assert.equal(directHttpsConnections, 0,
      'a rejected proxy tunnel must not fall back to a direct HTTPS connection');
  }

  await assertRoutes({ HTTP_PROXY: first.url, HTTPS_PROXY: second.url }, first, second);
  await assertRoutes({ HTTP_PROXY: second.url, http_proxy: first.url,
    HTTPS_PROXY: first.url, https_proxy: second.url }, first, second);
  await assertRoutes({ ALL_PROXY: first.url }, first, first);
  await assertRoutes({ ALL_PROXY: second.url, all_proxy: first.url }, first, first);
  await assertRoutes({ ALL_PROXY: first.url, HTTPS_PROXY: second.url }, first, second);

  const beforeCompressed = first.connections.length;
  configure({ HTTP_PROXY: first.url });
  const compressed = await fetch(`http://${origin}/oauth-gzip-fixture`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(compressed.status, 200);
  assert.deepEqual(await compressed.json(), { token: 'fixture-only', message: '压缩响应' },
    'compressed OAuth JSON must be decoded exactly once');
  assert.deepEqual(first.connections.slice(beforeCompressed), [origin]);

  const beforeBypass = [first.connections.length, second.connections.length];
  configure({ HTTP_PROXY: first.url, HTTPS_PROXY: second.url, NO_PROXY: '127.0.0.1' });
  assert.equal(await fetchBody(httpUrl), 'local origin');
  assert.deepEqual([first.connections.length, second.connections.length], beforeBypass,
    'NO_PROXY must bypass the proxy for matching local destinations');
  configure({ HTTP_PROXY: first.url, NO_PROXY: 'invalid.example', no_proxy: '127.0.0.1' });
  assert.equal(await fetchBody(httpUrl), 'local origin');
  assert.deepEqual([first.connections.length, second.connections.length], beforeBypass,
    'lowercase no_proxy must take precedence');

  // Confirm the production default argument reads process.env, not just the
  // explicit environment objects used to isolate the other scenarios.
  process.env.HTTP_PROXY = first.url;
  process.env.HTTPS_PROXY = second.url;
  process.env.NO_PROXY = '';
  await assertRoutes(undefined, first, second);
  for (const key of proxyKeys) delete process.env[key];

  const unavailable = net.createServer();
  const unavailableAddress = await listen(unavailable);
  await new Promise(resolve => unavailable.close(resolve));
  const beforeFailure = originRequests;
  configure({ HTTP_PROXY: `http://${unavailableAddress}` });
  await assert.rejects(fetch(httpUrl, { signal: AbortSignal.timeout(3000) }));
  assert.equal(originRequests, beforeFailure,
    'an unavailable proxy must fail without silently connecting directly');

  console.log('PASS OAuth global fetch: dynamic proxy ports, HTTP/HTTPS routing, gzip JSON, lowercase precedence, ALL_PROXY, NO_PROXY, inherited environment, and no direct fallback');
} finally {
  setGlobalDispatcher(originalDispatcher);
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  for (const key of proxyKeys) delete process.env[key];
  for (const [key, value] of savedEnvironment) {
    if (value !== undefined) process.env[key] = value;
  }
  await Promise.all(agents.map(agent => agent.destroy()));
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.filter(server => server.listening)
    .map(server => new Promise(resolve => server.close(resolve))));
}
