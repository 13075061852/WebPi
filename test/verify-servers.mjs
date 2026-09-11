import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import net from 'node:net';
const { Server } = ssh2;
import { ServerManager } from '../src/main/servers.mjs';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
let connections = 0;
const server = new Server({ hostKeys: [privateKey] }, client => {
  connections++;
  client.on('authentication', ctx => ctx.username === 'tester' && ctx.password === 'test-only' ? ctx.accept() : ctx.reject());
  client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptExec, _reject, info) => {
    const stream = acceptExec(); stream.write('remote:' + info.command); stream.exit(0); stream.end();
  })));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const store = { data: {}, set(key, value) { this.data[key] = value; } };
const manager = new ServerManager(store, s => Buffer.from(s).toString('base64'), s => Buffer.from(s, 'base64').toString());
try {
  manager.save({ name: 'Test', host: '127.0.0.1', port: server.address().port, username: 'tester', secret: 'test-only' });
  const id = manager.list()[0].id;
  assert.equal('secret' in manager.list()[0], false);
  const results = await Promise.all(Array.from({ length: 6 }, () => manager.exec(id, 'hostname')));
  const result = results[0];
  assert.equal(connections, 1, 'Concurrent commands must share one SSH connection');
  assert.equal(manager.connectionRequests.size, 0);
  assert.equal(result.output, 'remote:hostname'); assert.equal(result.code, 0);
  assert.ok(manager.list()[0].fingerprint);
  const before = store.data.servers[0].secret;
  manager.save({ ...manager.list()[0], name: 'Renamed', secret: '' });
  assert.equal(manager.list()[0].id, id);
  assert.equal(store.data.servers[0].secret, before);
  assert.equal(manager.list()[0].connected, true);
  manager.save({ name: 'Second', host: 'localhost', username: 'tester', secret: 'second' });
  const second = manager.list()[1].id;
  manager.reorder([second, id]);
  assert.deepEqual(manager.list().map(s => s.id), [second, id]);
  assert.throws(() => manager.reorder([id, id]));
  const reloaded = new ServerManager(store, s => s, s => s);
  assert.equal(reloaded.list()[0].id, second);
  manager.remove(id); manager.remove(second); assert.equal(manager.list().length, 0);
  console.log('PASS SSH auth, remote execution, fingerprint, secret redaction and removal');
} finally { manager.dispose(); server.close(); }

// Deletion while the SSH handshake is pending must cancel, never resurrect the server.
const sockets = new Set();
const stalled = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
try {
  manager.save({ name: 'Pending', host: '127.0.0.1', port: stalled.address().port, username: 'tester', secret: 'test-only' });
  const id = manager.list()[0].id;
  const pending = manager.connect(id);
  const rejected = assert.rejects(pending, /取消/);
  manager.remove(id);
  await rejected;
  assert.equal(manager.clients.size, 0);
  assert.equal(manager.connectionRequests.size, 0);
  assert.equal(manager.list().length, 0);
  console.log('PASS concurrent SSH reuse and pending connection cancellation');
} finally { manager.dispose(); for (const socket of sockets) socket.destroy(); stalled.close(); }
