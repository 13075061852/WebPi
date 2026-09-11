import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { ServerManager } from '../src/main/servers.mjs';
const manager = new ServerManager({ data: {} }, x => x, x => x);
const client = new EventEmitter();
client.end = () => client.emit('close');
// Accept a forwarded connection but never answer its TLS probe.
const streams = [];
client.forwardOut = (_address, _sourcePort, _host, _port, done) => {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } }); streams.push(stream); done(null, stream);
};
manager.clients.set('test', client);
const a = manager.preview('test', { port: 8444, address: '*', protocol: 'TCP', pid: 1 });
const b = manager.preview('test', { port: 8444, address: '0.0.0.0', protocol: 'TCP', pid: 2 });
const rejectedA = assert.rejects(a, /关闭/), rejectedB = assert.rejects(b, /关闭/);
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(manager.previewRequests.size, 1);
assert.equal(manager.previews.size, 1);
manager.disconnect('test');
await Promise.all([rejectedA, rejectedB]);
assert.equal(manager.previews.size, 0);
assert.equal(manager.previewRequests.size, 0);
assert.equal(client.listenerCount('close'), 0);
await new Promise(resolve => setTimeout(resolve, 20));
assert.ok(streams.every(stream => stream.destroyed));
console.log('PASS deduplicated preview probes, disconnect cancellation, tunnel and listener cleanup');
