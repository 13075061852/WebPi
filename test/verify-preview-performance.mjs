import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { ServerManager } from '../src/main/servers.mjs';

// Public, disposable test credentials. No personal servers or account state are used.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgs5ISw42QiiabTB1T
ntUK4KVR0cUD6kRNV3s7hJxeRzGhRANCAATfooKnO/3fztd+QvStJjw8iC6J34H2
QvT1AqKK2ncSjwM7WMOYVp6dC0eDjOp8k+wYoNjUR2Ciu8pB2FfAkB2O
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
MIIBlDCCATmgAwIBAgIUTp9qTthmZxy2N/jm+7+xNL6I5hIwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAwOTAzMzgyMVoXDTM2MTAwNjAz
MzgyMVowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAE36KCpzv9387XfkL0rSY8PIguid+B9kL09QKiitp3Eo8DO1jDmFaenQtH
g4zqfJPsGKDY1EdgorvKQdhXwJAdjqNpMGcwHQYDVR0OBBYEFK+QvV6Ez2hR/6Bo
lbQfXNxN9LlVMB8GA1UdIwQYMBaAFK+QvV6Ez2hR/6BolbQfXNxN9LlVMA8GA1Ud
EwEB/wQFMAMBAf8wFAYDVR0RBA0wC4IJbG9jYWxob3N0MAoGCCqGSM49BAMCA0kA
MEYCIQDAPrHAumHFpt5cezjbTIOcZ+T4u8DY8WHN4DCz5YPlcQIhAOqF7LRaRxWv
TnFX43LwW3iy80oN9PRcL63S5V81HDkL
-----END CERTIFICATE-----`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listen(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server, port: server.address().port,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

function attachClient(manager, forward) {
  const client = new EventEmitter(); client.end = () => client.emit('close');
  client.forwardOut = forward;
  manager.clients.set('fixture', client);
  return client;
}

function forwardedManager({ delay = 0, previewTimeoutMs = 4000, servers = [] } = {}) {
  const manager = new ServerManager({ data: { servers } }, x => x, x => x, { previewTimeoutMs });
  const channels = [], timers = new Set();
  attachClient(manager, (_source, _sourcePort, host, port, callback) => {
    const stream = net.connect(port, host, () => {
      const timer = setTimeout(() => { timers.delete(timer); callback(null, stream); }, delay);
      timers.add(timer);
    });
    stream.on('error', () => {}); channels.push(stream);
  });
  return {
    manager, channels,
    async close() { manager.dispose(); await wait(delay + 20); for (const timer of timers) clearTimeout(timer); for (const channel of channels) channel.destroy(); },
  };
}

const item = port => ({ address: '127.0.0.1', port, protocol: 'TCP' });
const body = Buffer.alloc(1024 * 1024, 65);
async function plainFixture(status = 200, extraHeaders = '') {
  const stats = { heads: 0, gets: 0, bodyBytes: 0 };
  const fixture = await listen(net.createServer(socket => {
    let handled = false;
    socket.on('data', data => {
      if (handled) return;
      const method = data.subarray(0, 5).toString();
      // Python-style HTTP handlers can wait indefinitely for a request line after TLS bytes.
      if (!method.startsWith('HEAD ') && !method.startsWith('GET ')) return;
      handled = true;
      const isHead = method.startsWith('HEAD ');
      if (isHead) stats.heads++; else { stats.gets++; stats.bodyBytes += body.length; }
      const header = Buffer.from(`HTTP/1.1 ${status} Fixture\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n${extraHeaders}\r\n`);
      socket.end(isHead ? header : Buffer.concat([header, body]));
    });
  }));
  return { ...fixture, stats };
}

const fixture = await plainFixture();
const forwarded = forwardedManager({ delay: 100 });
let measured;
try {
  const started = performance.now();
  const [url, duplicate] = await Promise.all([
    forwarded.manager.preview('fixture', item(fixture.port)),
    forwarded.manager.preview('fixture', { ...item(fixture.port), address: '*', pid: 42 }),
  ]);
  const previewMs = performance.now() - started;
  assert.equal(url, duplicate, 'Concurrent equivalent port selections share one tunnel');
  assert.match(url, /^http:\/\/127\.0\.0\.1:/);
  assert.ok(previewMs < 1500, `HTTP must not wait for silent TLS: ${previewMs} ms`);
  assert.equal(fixture.stats.heads, 1); assert.equal(fixture.stats.gets, 0); assert.equal(fixture.stats.bodyBytes, 0);
  const fetchStarted = performance.now();
  assert.equal((await (await fetch(url)).arrayBuffer()).byteLength, body.length);
  const fetchMs = performance.now() - fetchStarted;
  const channelCount = forwarded.channels.length, cacheStarted = performance.now();
  assert.equal(await forwarded.manager.preview('fixture', item(fixture.port)), url);
  const cachedPreviewMs = performance.now() - cacheStarted;
  assert.equal(forwarded.channels.length, channelCount, 'Reopening must not probe again');
  assert.equal(fixture.stats.gets, 1); assert.equal(fixture.stats.bodyBytes, body.length);
  measured = { previewMs: Math.round(previewMs), pageFetchMs: Math.round(fetchMs), cachedPreviewMs: Math.round(cachedPreviewMs), forwardChannels: channelCount, homepageHEADs: fixture.stats.heads, homepageGETs: fixture.stats.gets, bytesSent: fixture.stats.bodyBytes };
} finally { await forwarded.close(); await fixture.close(); }

for (const status of [405, 501]) {
  const unsupported = await plainFixture(status), session = forwardedManager();
  try {
    assert.match(await session.manager.preview('fixture', item(unsupported.port)), /^http:/, `HEAD ${status} still identifies HTTP`);
    assert.equal(unsupported.stats.heads, 1); assert.equal(unsupported.stats.gets, 0);
  } finally { await session.close(); await unsupported.close(); }
}

// A slow, usable HEAD must retain the same full budget as a normal GET.
const slowTimers = new Set();
let slowHeads = 0, slowGets = 0;
const slowHead = await listen(net.createServer(socket => socket.on('data', data => {
  const method = data.subarray(0, 5).toString();
  if (!method.startsWith('HEAD ') && !method.startsWith('GET ')) return;
  if (method.startsWith('HEAD ')) slowHeads++; else slowGets++;
  const timer = setTimeout(() => { slowTimers.delete(timer); if (!socket.destroyed) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); }, 350);
  slowTimers.add(timer);
})));
const slowSession = forwardedManager({ previewTimeoutMs: 500 });
try {
  assert.match(await slowSession.manager.preview('fixture', item(slowHead.port)), /^http:/);
  assert.equal(slowHeads, 1); assert.equal(slowGets, 0, 'Do not restart a slow but working HEAD as GET');
} finally { await slowSession.close(); for (const timer of slowTimers) clearTimeout(timer); await slowHead.close(); }

// Single-threaded HTTP services process accepted sockets in order. A TLS request
// ahead of HEAD would occupy the only worker and hide an otherwise fast page.
for (const mode of ['normal', 'close-head', 'silent-head']) {
  const queue = [];
  let active = null, heads = 0, gets = 0, tlsFirst = false;
  const pump = () => {
    if (active || !queue.length) return;
    const socket = queue.shift();
    if (socket.destroyed) { pump(); return; }
    active = socket;
    socket.on('close', () => { if (active === socket) active = null; pump(); });
    socket.on('data', data => {
      const method = data.subarray(0, 5).toString();
      if (method.startsWith('HEAD ')) {
        heads++;
        if (mode === 'close-head') { socket.destroy(); return; }
        if (mode === 'silent-head') return;
      } else if (method.startsWith('GET ')) gets++;
      else { if (!heads) tlsFirst = true; return; }
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    socket.resume();
  };
  const serial = await listen(net.createServer(socket => { socket.pause(); queue.push(socket); pump(); }));
  const session = forwardedManager({ delay: 20, previewTimeoutMs: 150 });
  try {
    const started = performance.now();
    assert.match(await session.manager.preview('fixture', item(serial.port)), /^http:/, `Serial HTTP ${mode} remains usable`);
    assert.ok(performance.now() - started < 1000);
    assert.equal(tlsFirst, false, 'HEAD must reach the single worker before a silent TLS request');
    assert.equal(heads, 1); assert.equal(gets, mode === 'normal' ? 0 : 1);
  } finally { await session.close(); await serial.close(); }
}

let requests = 0;
const responseTimers = new Set();
const secure = await listen(https.createServer({ key, cert }, (_request, response) => {
  requests++;
  const timer = setTimeout(() => { responseTimers.delete(timer); response.end('slow application route'); }, 650);
  responseTimers.add(timer);
}));
secure.server.on('tlsClientError', () => {});
const secureSession = forwardedManager({ delay: 50 });
try {
  const started = performance.now(), url = await secureSession.manager.preview('fixture', item(secure.port));
  assert.match(url, /^https:\/\/127\.0\.0\.1:/);
  assert.ok(performance.now() - started < 1000, 'TLS discovery does not wait for the application route');
  assert.equal(requests, 0, 'TLS discovery must not make an HTTP request');
  assert.equal([...secureSession.manager.previews.values()][0].fingerprint, new X509Certificate(cert).fingerprint256, 'Only the authenticated tunnel certificate is pinned');
  await new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, response => {
      response.resume(); response.on('end', resolve);
    }).on('error', reject);
  });
  assert.equal(requests, 1, 'The actual page is the only application request');
} finally { await secureSession.close(); for (const timer of responseTimers) clearTimeout(timer); await secure.close(); }

for (const [status, headers] of [[400, ''], [301, 'Location: https://localhost/\r\n']]) {
  const ordinary = await plainFixture(status, headers), session = forwardedManager({ previewTimeoutMs: 120 });
  try {
    assert.match(await session.manager.preview('fixture', item(ordinary.port)), /^http:/, `HTTP ${status} remains usable after TLS is ruled out`);
  } finally { await session.close(); await ordinary.close(); }
}

for (const [status, headers] of [[426, 'Upgrade: TLS/1.2\r\n'], [200, 'Upgrade: TLS/1.2\r\n']]) {
  const upgrade = await plainFixture(status, headers), session = forwardedManager({ previewTimeoutMs: 120 });
  try {
    await assert.rejects(session.manager.preview('fixture', item(upgrade.port)), /网页服务|证书/);
    assert.equal(session.manager.previews.size, 0, `HTTP ${status} must not incorrectly select a TLS-only endpoint`);
  } finally { await session.close(); await upgrade.close(); }
}

// A trickled status line prevents an inactivity timeout but cannot extend the wall deadline.
const trickleTimers = new Set();
const stalled = await listen(net.createServer(socket => socket.on('data', data => {
  if (!data.subarray(0, 5).equals(Buffer.from('HEAD '))) return;
  const timer = setInterval(() => { if (!socket.destroyed) socket.write('H'); }, 20);
  trickleTimers.add(timer); socket.on('close', () => { clearInterval(timer); trickleTimers.delete(timer); });
})));
const stalledSession = forwardedManager({ previewTimeoutMs: 180 });
try {
  const started = performance.now();
  await assert.rejects(stalledSession.manager.preview('fixture', item(stalled.port)), /网页服务|证书/);
  assert.ok(performance.now() - started < 1000, 'Socket traffic cannot restart the wall-clock deadline');
  assert.equal(stalledSession.manager.previews.size, 0); assert.equal(stalledSession.manager.previewRequests.size, 0);
} finally { await stalledSession.close(); for (const timer of trickleTimers) clearInterval(timer); await stalled.close(); }

// Neither a late forwardOut callback nor a pending channel can survive cancellation.
for (const disconnect of [false, true]) {
  const manager = new ServerManager({ data: { servers: [] } }, x => x, x => x, { previewTimeoutMs: 100 });
  const pending = [];
  const client = attachClient(manager, (_source, _sourcePort, _host, _port, done) => pending.push(done));
  const started = performance.now(), preview = manager.preview('fixture', item(8444));
  const rejected = assert.rejects(preview, disconnect ? /关闭/ : /网页服务|证书/);
  await wait(30);
  assert.equal(pending.length, 1, 'TLS must not overtake an unresolved initial HEAD channel');
  if (disconnect) manager.disconnect('fixture');
  await rejected;
  assert.ok(performance.now() - started < 1000);
  for (const done of pending) {
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    done(null, stream); assert.ok(stream.destroyed, 'Late SSH channel must be destroyed');
  }
  assert.equal(manager.previews.size, 0); assert.equal(manager.previewRequests.size, 0); assert.equal(client.listenerCount('close'), 0);
  manager.dispose();
}

// A public self-signed certificate must never inherit the SSH tunnel's trust exception.
const publicSecure = await listen(https.createServer({ key, cert }, (_request, response) => response.end('untrusted')));
publicSecure.server.on('tlsClientError', () => {});
const publicManager = new ServerManager({ data: { servers: [{ id: 'fixture', host: '127.0.0.1' }] } }, x => x, x => x, { previewTimeoutMs: 120 });
attachClient(publicManager, (_source, _sourcePort, _host, _port, callback) => callback(Error('Tunnel fixture unavailable')));
try {
  await assert.rejects(publicManager.preview('fixture', item(publicSecure.port)), /网页服务|证书/);
  assert.equal(publicManager.previews.size, 0);
} finally { publicManager.dispose(); await publicSecure.close(); }

// Public SNI fallback retains normal CA/hostname checks and the application's HTTPS
// agent. A GET-only public route can be discovered without consuming its response body.
const previousAgent = https.globalAgent;
https.globalAgent = new https.Agent({
  ca: cert,
  lookup: (_hostname, options, callback) => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
});
let publicHeads = 0, publicGets = 0, publicBodyBytes = 0;
const publicTimers = new Set();
const trustedPublic = await listen(https.createServer({ key, cert }, (request, response) => {
  if (request.method === 'HEAD') { publicHeads++; request.socket.destroy(); return; }
  publicGets++;
  response.writeHead(200, { 'Content-Length': body.length }); response.flushHeaders();
  const timer = setTimeout(() => { publicTimers.delete(timer); if (!response.destroyed) { publicBodyBytes += body.length; response.end(body); } }, 50);
  publicTimers.add(timer);
}));
trustedPublic.server.on('tlsClientError', () => {});
const trustedManager = new ServerManager({ data: { servers: [{ id: 'fixture', host: '127.0.0.1' }] } }, x => x, x => x, { previewTimeoutMs: 500 });
attachClient(trustedManager, (_source, _sourcePort, _host, _port, callback) => callback(Error('Tunnel fixture unavailable')));
try {
  assert.equal(await trustedManager.preview('fixture', item(trustedPublic.port)), `https://localhost:${trustedPublic.port}/`);
  assert.equal([...trustedManager.previews.values()][0].fingerprint, undefined, 'Public certificates are not granted tunnel pinning trust');
  assert.equal(publicHeads, 1); assert.equal(publicGets, 1);
  await wait(80);
  assert.equal(publicBodyBytes, 0, 'GET fallback must stop at headers');
} finally {
  trustedManager.dispose(); for (const timer of publicTimers) clearTimeout(timer); await trustedPublic.close();
  https.globalAgent.destroy(); https.globalAgent = previousAgent;
}

if (process.argv.includes('--report')) {
  const report = {
    measuredAt: new Date().toISOString(), fixture: 'Loopback raw TCP HTTP service ignores TLS bytes; each forwarded channel is delayed 100 ms; GET response is 1 MiB.',
    baseline: { previewMs: 12131, pageFetchMs: 135, cachedPreviewMs: 0, forwardChannels: 4, homepageGETs: 2, bytesSent: 2097152, execution: 'Before source optimization: an inline ESM script piped into node --input-type=module imported ServerManager, registered an EventEmitter SSH client forwarding to the raw TCP fixture, then measured preview(), fetch(url), and cached preview() using performance.now().' },
    optimized: measured, execution: 'node test/verify-preview-performance.mjs --report',
  };
  await fs.mkdir(new URL('./results/', import.meta.url), { recursive: true });
  await fs.writeFile(new URL('./results/server-preview-performance.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
console.log('PASS parallel HTTP/TLS preview, HEAD compatibility, pinned certificates, body download avoidance, bounded probes and cancellation');
console.log(JSON.stringify(measured));
