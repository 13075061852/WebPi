import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { ServerManager } from '../src/main/servers.mjs';
function fixture(callback) {
  const manager = new ServerManager({ data: {} }, x => x, x => x);
  const stream = new EventEmitter(); stream.stderr = new EventEmitter();
  stream.close = () => stream.emit('close', 0);
  manager.clients.set('test', { exec: (_command, done) => callback(done, stream) });
  return { manager, stream };
}
{
  const { manager } = fixture((done, stream) => {
    done(null, stream);
    queueMicrotask(() => {
      const text = Buffer.from('中文🙂');
      for (const byte of text) stream.emit('data', Buffer.from([byte]));
      stream.emit('data', Buffer.from('a'.repeat(200001)));
      stream.close();
    });
  });
  const result = await manager.exec('test', 'test');
  assert.ok(result.output.startsWith('中文🙂'));
  assert.ok(result.output.endsWith('[输出已截断]'));
}
{
  const controller = new AbortController();
  const { manager, stream } = fixture(done => done(null, stream));
  const pending = manager.exec('test', 'test', controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(stream.listenerCount('data'), 0);
}
{
  const controller = new AbortController(); let complete;
  const { manager, stream } = fixture(done => { complete = done; });
  let closed = false; stream.close = () => { closed = true; };
  const pending = manager.exec('test', 'test', controller.signal);
  await Promise.resolve(); controller.abort();
  await assert.rejects(pending, /取消/);
  complete(null, stream);
  assert.equal(closed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
}
{
  const controller = new AbortController();
  const { manager, stream } = fixture(done => done(null, stream));
  const pending = manager.exec('test', 'test', controller.signal);
  await Promise.resolve(); stream.emit('error', Error('channel failed'));
  await assert.rejects(pending, /channel failed/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
}
console.log('PASS split UTF-8, truncation, synchronous close cancellation, late channel cleanup and error cleanup');
