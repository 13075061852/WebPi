import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createStartupLifecycle } from '../src/main/startup-lifecycle.mjs';

// A painted shell warms the core, but the small window stays until work completes.
for (const order of [['painted', 'wired'], ['wired', 'painted']]) {
  let time = 120, reveals = 0, starts = 0;
  const updates = [];
  const lifecycle = createStartupLifecycle({ now: () => time, onChange: state => updates.push(state), onInterfaceReady: () => starts++, reveal: () => reveals++ });
  lifecycle[order[0]]();
  assert.equal(reveals, 0, 'A blank or unwired window must not be shown');
  time = 200; lifecycle[order[1]]();
  assert.equal(starts, 1, 'Start core preparation as soon as the hidden shell is ready');
  assert.equal(reveals, 0, 'Do not show the large window over the launch animation');
  assert.equal(lifecycle.snapshot().ready, false);
  lifecycle.painted(); lifecycle.wired();
  assert.equal(starts, 1, 'Duplicate paint/wiring must not start the core twice');
  time = 450; lifecycle.begin('core');
  time = 750; lifecycle.complete('core'); lifecycle.begin('workspace');
  assert.equal(lifecycle.snapshot().ready, false, 'Session ready must not imply history restoration complete');
  assert.equal(reveals, 0, 'History restoration must finish before the handoff');
  time = 950; lifecycle.complete('workspace');
  const ready = lifecycle.snapshot();
  assert.equal(ready.ready, true);
  assert.equal(ready.timings.windowShown, 950);
  assert.equal(ready.timings.workspaceReady, 950);
  lifecycle.complete('workspace');
  assert.equal(reveals, 1, 'Repeated completion cannot reveal twice');
  assert.ok(updates.length > 4);
}

for (const stage of ['core', 'workspace']) {
  let reveals = 0;
  const lifecycle = createStartupLifecycle({ reveal: () => reveals++ });
  lifecycle.painted(); lifecycle.wired();
  if (stage === 'workspace') lifecycle.complete('core');
  lifecycle.fail(stage, new Error('加载失败'));
  const failure = lifecycle.snapshot();
  assert.equal(reveals, 1, 'Failures must expose the main retry controls instead of trapping the splash');
  assert.equal(failure.ready, false);
  lifecycle.begin(stage); lifecycle.complete('core'); lifecycle.complete('workspace');
  assert.equal(lifecycle.snapshot().ready, true);
  assert.equal(reveals, 1);
  assert.equal(failure.steps.find(step => step.id === stage).status, 'error');
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
console.log('PASS small-window startup gate, hidden core preparation, workspace handoff, failure recovery, close race and early event retention');
