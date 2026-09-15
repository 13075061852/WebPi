import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-session-integrity-');
const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
const a = path.join(fixture.dir, 'a'), b = path.join(fixture.dir, 'b');
fs.mkdirSync(a); fs.mkdirSync(b);
const store = new HaloStore(path.join(fixture.dir, 'settings.json'));
store.set('projects', [{ cwd: a }]);
const bridge = new PiBridge(store, {}, { sessionDir: path.join(fixture.dir, 'sessions') });
bridge.servers = { list: () => [{ id: 'server-a' }, { id: 'server-b' }] };
const record = (text) => {
  const message = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
  bridge.session.sessionManager.appendMessage(message);
  bridge.session.agent.state.messages.push(message);
  bridge._noteSession();
  return bridge.session.sessionFile;
};
try {
  await bridge.start(a);
  const fileA = record('A');
  const message = { role: 'assistant', content: [{ type: 'text', text: 'done' }],
    usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: { total: 0.1 } } };
  bridge.session.sessionManager.appendMessage(message);
  bridge.session.agent.state.messages.push(message);
  bridge.session.emit({ type: 'message_end', message });
  bridge.session.emit({ type: 'turn_end', message, toolResults: [] });
  const expected = { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: 0.1 };
  assert.deepEqual(bridge.publicState().usage, expected);
  bridge._recomputeUsageFromSession();
  assert.deepEqual(bridge.publicState().usage, expected, 'Live usage equals restored history usage');

  await bridge.start(a);
  assert.equal(bridge.session.sessionFile, fileA, 'Restart restores the last session without clicking it');
  assert.deepEqual(bridge.publicState().usage, expected, 'Startup state includes restored usage');
  await bridge.start(a);
  assert.deepEqual(bridge.publicState().usage, expected, 'Repeated restart must not double count usage');

  const runningSession = bridge.session;
  runningSession.isStreaming = true;
  await bridge.newSession();
  const { SessionManager } = await import('./fixtures/pi-sdk.js');
  const originalList = SessionManager.list;
  try {
    SessionManager.list = async () => []; // The SDK has not indexed the new file yet.
    const listed = await bridge.listSessions(a);
    const background = listed.find(item => item.file === fileA);
    assert.ok(background, 'Background conversation survives an empty disk index');
    assert.equal(background.running, true);
    assert.equal(background.name, 'A');
    assert.equal(background.id, runningSession.sessionId);
    assert.equal((await bridge.listSessions(b)).some(item => item.file === fileA), false);
  } finally { SessionManager.list = originalList; runningSession.isStreaming = false; }
  await bridge.openSession(fileA);
  assert.equal((await bridge.listSessions(a)).filter(item => item.file === fileA).length, 1, 'Disk and live lists are deduplicated');

  await bridge.switchProject(b);
  const fileB = record('B');
  bridge.session.isStreaming = true;
  await assert.rejects(bridge.deleteSession(fileB), /任务进行中/);
  assert.ok(fs.existsSync(fileB));
  bridge.session.isStreaming = false;
  assert.equal((await bridge.deleteSession(fileB)).switched, true);
  assert.equal(PiBridge.normPath(bridge.cwd), PiBridge.normPath(b));
  assert.equal(PiBridge.normPath(bridge.session.sessionManager.getCwd()), PiBridge.normPath(b));
  assert.notEqual(bridge.session.sessionFile, fileA);
  assert.equal(store.data.projects.find(p => PiBridge.normPath(p.cwd) === PiBridge.normPath(b)).lastSession, null);
  assert.ok(fs.existsSync(fileA), 'Deleting B preserves A history');
  const localB = bridge.session.sessionFile;
  await bridge.openSession(fileA);
  assert.equal(PiBridge.normPath(bridge.publicState().cwd), PiBridge.normPath(a));
  assert.deepEqual(bridge.publicState().usage, expected);
  await bridge.openSession(localB);

  await bridge.newSession('server-a');
  const firstServer = record('server A older'), firstId = bridge.session.sessionId;
  await bridge.newSession('server-b');
  const otherServer = record('server B'), otherId = bridge.session.sessionId;
  await bridge.newSession('server-a');
  const currentServer = record('server A newest'), currentId = bridge.session.sessionId;
  await bridge.deleteSession(currentServer);
  assert.equal(bridge.session.sessionFile, firstServer, 'Deleting a server session stays on that server when possible');
  assert.equal(bridge.serverTargets.get(bridge.session.sessionId), 'server-a');
  assert.equal(bridge.serverTargets.has(currentId), false);
  await bridge.deleteSession(firstServer);
  assert.equal(bridge.session.sessionFile, localB, 'The last server session returns to the selected local project');
  assert.equal(PiBridge.normPath(bridge.session.sessionManager.getCwd()), PiBridge.normPath(b));
  assert.equal(PiBridge.normPath(bridge.cwd), PiBridge.normPath(b));
  assert.equal(bridge.serverTargets.has(firstId), false);
  assert.equal((await bridge.serverConversations()).some(row => row.serverId === 'server-a'), false);
  assert.equal((await bridge.deleteSession(otherServer)).switched, false);
  assert.equal(bridge.serverTargets.has(otherId), false);
  assert.equal((await bridge.serverConversations()).length, 0);
  const saved = new HaloStore(store.file);
  assert.equal(saved.data.serverSessions[firstServer], undefined);
  assert.equal(saved.data.serverLastSessions['server-a'], undefined);
  console.log('PASS usage counts once; project deletion/cwd isolation; busy rejection; server fallback and persistent cleanup');
} finally {
  await bridge.dispose();
  fixture.cleanup();
}
