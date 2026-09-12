import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiBridge, HaloStore } from '../src/main/pi-bridge.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-session-models-'));
const store = new HaloStore(path.join(dir, 'settings.json'));
const bridge = new PiBridge(store, {}, { sessionDir: path.join(dir, 'sessions') });
const key = m => `${m.provider}/${m.id}`;
try {
  store.set('projects', [{ cwd: dir }]);
  await bridge.start(dir);
  const models = (await bridge.listModels()).filter(m => m.id);
  assert.ok(models.length >= 2, 'Need two configured models for regression');
  const [a, b] = models;
  // No inference requests: only exercise model selection and session persistence.
  bridge.modelRuntime.checkAuth = async () => true;
  store.set('defaultModel', key(a));
  await bridge.setModel(b.provider, b.id);
  const first = bridge.session.sessionFile;
  await bridge.newSession(); // Reusing an empty draft must preserve its selection.
  assert.equal(bridge.session.sessionFile, first);
  assert.equal(key(bridge.session.model), key(b));
  const message = { role: 'assistant', content: [{ type: 'text', text: 'fixture' }],
    api: 'openai-completions', provider: b.provider, model: b.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now() };
  bridge.session.sessionManager.appendMessage(message);
  bridge.session.agent.state.messages = [message];
  await bridge.newSession();
  const second = bridge.session.sessionFile;
  assert.notEqual(second, first);
  assert.equal(key(bridge.session.model), key(a), 'New session uses default');
  store.set('defaultModel', key(b));
  await bridge.openSession(first);
  assert.equal(key(bridge.session.model), key(b));
  await bridge.openSession(second);
  assert.equal(key(bridge.session.model), key(a), 'Default change must not overwrite existing draft');
  await bridge.openSession(first);
  await bridge.start(dir); // Reconstruct runtime from the saved session file.
  assert.equal(key(bridge.session.model), key(b), 'Saved selection survives runtime restart');
  store.set('defaultModel', key(a));
  await bridge.start(dir);
  assert.equal(key(bridge.session.model), key(b), 'Restart must ignore changed default');
  console.log('PASS per-session models, draft reuse, new-session default, switching and disk restoration');
} finally { await bridge.dispose(); }
process.exit(0);


