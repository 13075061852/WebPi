import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';
const fixture = isolatePi('halo-session-files-');
const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
const root = path.join(fixture.dir, 'sessions'), outside = path.join(fixture.dir, 'sessions-other');
fs.mkdirSync(root); fs.mkdirSync(outside);
const store = new HaloStore(path.join(fixture.dir, 'settings.json'));
const bridge = new PiBridge(store, {}, { sessionDir: root });
try {
  await bridge.start(fixture.dir);
  const draft = bridge.session.sessionFile;
  await bridge.openSession(draft); // Missing files are allowed only for live drafts.
  bridge.session.sessionManager.appendMessage({ role: 'user', content: 'inside', timestamp: Date.now() });
  const inside = bridge.session.sessionFile;
  const external = path.join(outside, 'external.jsonl');
  fs.copyFileSync(inside, external);
  const empty = path.join(outside, 'empty.jsonl'); fs.writeFileSync(empty, '');
  const escape = path.join(root, 'escape');
  fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  const original = bridge.session;
  for (const file of [external, empty, path.join(root, '..', 'sessions-other', 'external.jsonl'),
    path.join(escape, 'external.jsonl'), path.join(root, 'missing.jsonl'), 'relative.jsonl', {}, null]) {
    await assert.rejects(bridge.openSession(file));
    await assert.rejects(bridge.deleteSession(file));
    assert.equal(bridge.session, original, 'Rejected paths cannot dispose or switch the current session');
  }
  assert.equal(fs.readFileSync(empty, 'utf8'), '', 'Opening an empty external file cannot rewrite it');
  assert.equal(fs.readFileSync(external, 'utf8'), fs.readFileSync(inside, 'utf8'));
  // Both aliases and normal paths must consult the same busy context.
  const alias = path.join(root, 'alias');
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = path.join(alias, path.basename(inside));
  bridge.session.isStreaming = true;
  await assert.rejects(bridge.deleteSession(aliased), /任务进行中/);
  const hardlink = path.join(root, 'hardlink.jsonl'); fs.linkSync(inside, hardlink);
  await assert.rejects(bridge.deleteSession(hardlink), /任务进行中/);
  await bridge.openSession(hardlink);
  assert.equal(bridge.session, original, 'Hardlinks cannot create a second runtime for a busy file');
  fs.rmSync(hardlink);
  await bridge.openSession(aliased);
  assert.equal(bridge.session, original);
  bridge.session.isStreaming = false;
  // A trusted legacy index grants one file, not its directory.
  store.data.serverSessions = { [external]: { file: external, serverId: 'legacy' } };
  bridge.servers = { list: () => [{ id: 'legacy' }] };
  await bridge.openSession(external);
  await assert.rejects(bridge.openSession(empty));
  await bridge.openSession(inside);
  await bridge.deleteSession(aliased);
  assert.equal(fs.existsSync(inside), false);
  assert.equal(fs.existsSync(external), true);
  const child = path.join(root, 'child'); fs.mkdirSync(child);
  const candidate = path.join(child, 'external.jsonl'); fs.copyFileSync(external, candidate);
  const stop = bridge.projectRuns.stopSession.bind(bridge.projectRuns);
  bridge.projectRuns.stopSession = async () => {
    fs.renameSync(child, child + '-original');
    fs.symlinkSync(outside, child, process.platform === 'win32' ? 'junction' : 'dir');
  };
  await assert.rejects(bridge.deleteSession(candidate), /目录之外/);
  assert.equal(fs.existsSync(external), true, 'A directory replacement during stop cannot redirect deletion');
  assert.equal(fs.existsSync(path.join(child + '-original', 'external.jsonl')), true);
  bridge.projectRuns.stopSession = stop;
  console.log('PASS external/empty/traversal/junction rejection; live draft, legacy index, alias identity and busy-session protection');
} finally { await bridge.dispose(); fixture.cleanup(); }
