import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { isolatePi } from './helpers/isolated-pi.mjs';
import { PiBridge, HaloStore } from '../src/main/pi-bridge.mjs';
import { presentConversations } from '../src/main/conversation-meta.mjs';

const fixture = isolatePi('halo-conversation-meta-');
const settings = path.join(fixture.dir, 'settings.json');
const store = new HaloStore(settings);
const bridge = new PiBridge(store, {}, {sessionDir:path.join(fixture.dir, 'sessions')});
bridge.servers = { list: () => [{id:'test-server'}] };
try {
  await bridge.start(fixture.dir);
  const files = [];
  for (let i = 0; i < 3; i++) {
    await bridge.newSession('test-server');
    bridge.session.sessionManager.appendMessage({role:'user', content:'Original ' + i});
    bridge.session.agent.state.messages.push({role:'user', content:'Original ' + i});
    bridge._noteSession();
    files.push(bridge.session.sessionFile);
    await bridge.serverConversations();
  }
  const order = (await bridge.serverConversations()).map(r => r.file);
  assert.deepEqual(order, [...files].reverse());
  await bridge.openSession(files[0]);
  bridge._noteSession();
  assert.deepEqual((await bridge.serverConversations()).map(r => r.file), order);
  const before = fs.readFileSync(files[1]);
  await bridge.renameSession(files[1], '  自定义 <标题>  ');
  assert.equal((await bridge.serverConversations()).find(r => r.file === files[1]).name, '自定义 <标题>');
  await bridge.openSession(files[1]);
  bridge._noteSession();
  assert.equal((await bridge.serverConversations()).find(r => r.file === files[1]).name, '自定义 <标题>');
  assert.deepEqual((await bridge.serverConversations()).map(r => r.file), order);
  assert.deepEqual(fs.readFileSync(files[1]), before, 'Renaming must preserve conversation content');
  const reloaded = new HaloStore(settings);
  const rows = presentConversations(reloaded, [...(await bridge.serverConversations())].reverse());
  assert.deepEqual(rows.map(r => r.file), order);
  assert.equal(rows.find(r => r.file === files[1]).name, '自定义 <标题>');
  await assert.rejects(bridge.renameSession(files[0], '   '));
  await assert.rejects(bridge.renameSession(files[0], 'x'.repeat(121)));
  await assert.rejects(bridge.renameSession(path.join(fixture.dir, 'missing.jsonl'), 'No'));
  console.log('PASS stable order across switching, persistent custom names, validation and untouched history');
} finally { await bridge.dispose(); fixture.cleanup(); }
