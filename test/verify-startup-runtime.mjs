import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-startup-runtime-');
const offline = process.env.PI_OFFLINE;
delete process.env.PI_OFFLINE;
const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
const { ModelRuntime } = await import('./fixtures/pi-sdk.js');
const originalCreate = ModelRuntime.create;
const bridges = [];
const pending = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let n = 0; n < 150; n++) {
    if (check()) return;
    await pause(20);
  }
  throw Error(label);
}
function newBridge(name) {
  const root = path.join(fixture.dir, name);
  fs.mkdirSync(root);
  const bridge = new PiBridge(new HaloStore(path.join(root, 'settings.json')), {}, { sessionDir: path.join(root, 'sessions') });
  bridges.push(bridge);
  return bridge;
}

try {
  const loading = pending(), refreshing = pending(), createOptions = [], refreshOptions = [];
  const models = [{ provider: 'custom', id: 'cached', name: 'Cached custom model' }];
  ModelRuntime.create = async options => {
    createOptions.push(options);
    await loading.promise;
    const runtime = await originalCreate();
    return { ...runtime, getAvailable: async () => models,
      refresh: async options => { refreshOptions.push(options); await refreshing.promise; },
    };
  };
  const bridge = newBridge('concurrent');
  const a = path.join(fixture.dir, 'project-a'), b = path.join(fixture.dir, 'project-b'), c = path.join(fixture.dir, 'project-c');
  for (const dir of [a, b, c]) fs.mkdirSync(dir);
  let stateEvents = 0;
  bridge.onEvent(channel => { if (channel === 'halo:state') stateEvents++; });
  const starts = [bridge.start(a), bridge.start(a.replaceAll('\\', '/')), bridge.start(a)];
  await until(() => createOptions.length === 1, 'SDK initialization never began');
  assert.equal(createOptions[0].allowModelNetwork, false, 'First ready state cannot wait on the network');
  loading.resolve();
  const states = await Promise.all(starts);
  assert.ok(states.every(state => state.ready));
  assert.equal(new Set(states.map(state => state.sessionId)).size, 1, 'Concurrent initialization keeps one session');
  assert.equal(refreshOptions.length, 0, 'Catalog refresh is deferred until after ready');
  assert.equal((await bridge.listModels())[0].id, 'cached', 'Cached/custom models are immediately usable');

  const session = bridge.session;
  let aborts = 0;
  const abort = session.abort.bind(session);
  session.abort = async () => { aborts++; await abort(); };
  session.isStreaming = true;
  await assert.rejects(bridge.start(a), /任务进行中/);
  assert.equal(bridge.session, session);
  assert.equal(aborts, 0, 'Repeated initialization cannot cancel an active task');

  await until(() => refreshOptions.length === 1, 'Background catalog refresh never began');
  assert.equal(refreshOptions[0].allowNetwork, true);
  models.push({ provider: 'custom', id: 'remote', name: 'New remote model' });
  const beforeRefresh = stateEvents;
  refreshing.resolve();
  await until(() => stateEvents > beforeRefresh, 'Catalog completion was not observable');
  assert.deepEqual((await bridge.listModels()).map(model => model.id), ['cached', 'remote']);
  assert.equal(bridge.session, session, 'Refreshing models cannot replace the conversation');
  assert.equal(session.isStreaming, true, 'Catalog refresh does not interrupt inference');
  assert.equal(aborts, 0);
  session.isStreaming = false;
  await bridge.start(a);
  assert.notEqual(bridge.session, session, 'A later explicit restart still reloads idle runtimes');
  let stalePrompts = 0;
  bridge.session.prompt = async () => { stalePrompts++; };
  const restarting = bridge.start(a);
  const queuedPrompt = assert.rejects(bridge.prompt('Arriving during restart'), /offline SDK fixture/);
  await Promise.all([restarting, queuedPrompt]);
  assert.equal(stalePrompts, 0, 'Prompts wait for initialization instead of using a session being disposed');

  const results = await Promise.all([bridge.start(a), bridge.start(b), bridge.start(c)]);
  assert.deepEqual(results.map(state => PiBridge.normPath(state.cwd)), [a, b, c].map(PiBridge.normPath));
  assert.equal(PiBridge.normPath(bridge.cwd), PiBridge.normPath(c), 'Different projects are serialized in request order');
  assert.equal(createOptions.length, 1, 'Restarts reuse the catalog runtime');

  let failureCalls = 0;
  ModelRuntime.create = async options => {
    assert.equal(options.allowModelNetwork, false);
    return { ...(await originalCreate()), refresh: async () => { failureCalls++; throw Error('Fixture network unavailable'); } };
  };
  const failed = newBridge('unavailable');
  await failed.start(a);
  const failedSession = failed.session;
  await until(() => failureCalls === 1, 'Failure fixture refresh never ran');
  await pause(30);
  assert.equal(failed.session, failedSession);
  assert.equal(failed.publicState().ready, true, 'Network failure leaves cached runtime usable');
  assert.equal((await failed.listModels()).length, 2);

  let signal;
  ModelRuntime.create = async () => ({ ...(await originalCreate()), refresh: async options => {
    signal = options.signal;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } });
  const closing = newBridge('closing');
  let closingEvents = 0;
  closing.onEvent(() => closingEvents++);
  await closing.start(a);
  await until(() => signal, 'Cancellation fixture refresh never began');
  const beforeClose = closingEvents;
  await closing.dispose();
  await pause(30);
  assert.equal(signal.aborted, true, 'Disposal aborts outstanding catalog network work');
  assert.equal(closingEvents, beforeClose, 'Closing cannot emit a stale catalog-ready event');

  process.env.PI_OFFLINE = '1';
  let offlineCalls = 0;
  ModelRuntime.create = async () => ({ ...(await originalCreate()), refresh: async () => { offlineCalls++; } });
  const offlineBridge = newBridge('offline');
  await offlineBridge.start(a);
  await pause(1650);
  assert.equal(offlineCalls, 0, 'Offline mode never schedules catalog network work');
  console.log('PASS offline-first ready, coalesced startup, ordered projects, busy protection, background catalog success/failure and disposal');
} finally {
  ModelRuntime.create = originalCreate;
  for (const bridge of bridges) await bridge.dispose();
  if (offline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = offline;
  fixture.cleanup();
}
