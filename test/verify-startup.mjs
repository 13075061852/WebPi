import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createStartupLifecycle } from '../src/main/startup-lifecycle.mjs';

// Cold core/network startup must never keep a painted, wired main window hidden.
for (const order of [['painted', 'wired'], ['wired', 'painted']]) {
  let time = 120, reveals = 0;
  const updates = [];
  const lifecycle = createStartupLifecycle({ now: () => time, onChange: state => updates.push(state), reveal: () => reveals++ });
  lifecycle[order[0]]();
  assert.equal(reveals, 0, 'A blank or unwired window must not be shown');
  time = 200; lifecycle[order[1]]();
  assert.equal(reveals, 1, 'Reveal immediately when the shell is both painted and wired');
  assert.equal(lifecycle.snapshot().ready, false, 'Visible shell is not falsely reported as ready AI');
  lifecycle.painted(); lifecycle.wired();
  assert.equal(reveals, 1, 'Duplicate Electron/IPC readiness cannot reveal twice');
  time = 450; lifecycle.begin('core'); lifecycle.fail('core', new Error('模型配置损坏'));
  const failure = lifecycle.snapshot();
  assert.equal(failure.steps[1].status, 'error');
  assert.equal(failure.steps[1].detail, '模型配置损坏');
  time = 750; lifecycle.begin('core', '正在重试'); lifecycle.complete('core'); lifecycle.begin('workspace');
  assert.equal(lifecycle.snapshot().ready, false, 'Session ready must not imply history restoration complete');
  time = 950; lifecycle.complete('workspace');
  const ready = lifecycle.snapshot();
  assert.equal(ready.ready, true);
  assert.equal(ready.timings.windowShown, 200);
  assert.equal(ready.timings.workspaceReady, 950);
  assert.equal(failure.steps[1].status, 'error', 'Snapshots remain stable for diagnostics');
  assert.ok(updates.length > 4);
}

// Closing/quitting while startup tasks are pending must never resurrect a window.
let reveals = 0, updates = 0;
const closed = createStartupLifecycle({ reveal: () => reveals++, onChange: () => updates++ });
closed.painted(); closed.dispose(); closed.wired(); closed.complete('core');
assert.equal(reveals, 0); assert.equal(updates, 0);

for (const readyFirst of [true, false]) {
  const failed = createStartupLifecycle({ reveal: () => reveals++ });
  if (readyFirst) failed.wired();
  failed.fail('interface', 'Renderer initialization failed');
  failed.painted(); failed.wired();
  assert.equal(reveals, 0, 'Late paint/readiness must not reveal a renderer that failed to initialize');
}

// Constructed-but-unwired renderers used to lose fatal startup errors and final ready state.
const source = fs.readFileSync('src/main/main.mjs', 'utf8');
const events = [];
const context = vm.createContext({
  mainWin: { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } },
  LIMITS: { EARLY_EVENTS: 2 },
});
const start = source.indexOf('  const pendingEvents = []');
const end = source.indexOf('  bridge.onEvent(emit);', start);
vm.runInContext(source.slice(start, end) + '\nglobalThis.send = emit; globalThis.listen = () => { rendererReady = true; flushPendingEvents(); };', context);
context.send('halo:state', { ready: false });
context.send('halo:error', { message: 'Initialization failed' });
context.send('pi:event', { seq: 1 });
context.send('halo:state', { ready: true });
assert.equal(events.length, 0);
context.listen();
assert.deepEqual(events.map(([channel]) => channel), ['halo:state', 'halo:error', 'pi:event']);
assert.equal(events[0][1].ready, true);
context.listen();
assert.equal(events.length, 3, 'Buffered events must not replay twice');
context.send('pi:event', { seq: 2 });
assert.equal(events.length, 4);
console.log('PASS startup real paint/wiring gate, independent core readiness, retry, timings, close race and early error/event retention');
