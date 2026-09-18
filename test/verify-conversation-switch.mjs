import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const start = source.indexOf('async function openSession(file) {');
const code = source.slice(start, source.indexOf('async function newSession()', start));
const clickStart = source.indexOf('button.addEventListener("click", async () => {', source.indexOf('async function loadProjects()'));
const click = source.slice(clickStart, source.indexOf('});', clickStart));
assert.ok(click.includes('openSession(session.file)'));
assert.ok(!click.includes('switchProject('), 'Conversation selection must not open the project default conversation first');

function harness() {
  const calls = [], pending = [];
  const S = { state: { cwd: 'C:/one' }, sessionSwitchSeq: 0 };
  const record = name => () => calls.push(name);
  const context = vm.createContext({ S, Promise,
    normPath: p => p.replaceAll('\\', '/').toLowerCase(),
    window: { halo: { openSession: file => { calls.push('open:' + file); return new Promise(resolve => pending.push(resolve)); } } },
    clearChat: record('clear'), applyProjectReset: record('reset'),
    applyState: state => { S.state = state; calls.push('state'); },
    restoreHistory: record('history'), loadSessions: record('sessions'), loadTree: record('tree'), loadResources: record('resources'),
    toast: record('error'), finishSessionSwitch: () => { S.switchingSession = false; calls.push('finish'); },
  });
  vm.runInContext(code, context);
  return { calls, pending, S, open: file => context.openSession(file) };
}
for (const cwd of ['C:/one', 'C:/two']) {
  const h = harness(), task = h.open('target');
  h.pending[0]({ ok: true, data: { cwd, sessionFile: 'target' } });
  await task;
  assert.equal(h.calls.filter(c => c === 'history').length, 1);
  assert.equal(h.calls.includes('tree'), cwd === 'C:/two');
  assert.equal(h.calls.includes('reset'), cwd === 'C:/two');
  assert.equal(h.S.state.sessionFile, 'target');
  assert.equal(h.S.switchingSession, false);
}
const rapid = harness();
const first = rapid.open('first'), second = rapid.open('second');
rapid.pending[0]({ ok: true, data: { cwd: 'C:/two', sessionFile: 'first' } });
await first;
assert.equal(rapid.calls.includes('history'), false);
rapid.pending[1]({ ok: true, data: { cwd: 'C:/three', sessionFile: 'second' } });
await second;
assert.equal(rapid.calls.filter(c => c === 'history').length, 1);
assert.equal(rapid.S.state.sessionFile, 'second');
const failed = harness(), failure = failed.open('missing');
failed.pending[0]({ ok: false, error: 'missing' }); await failure;
assert.equal(failed.calls.includes('history'), false);
assert.equal(failed.calls.includes('error'), true);
assert.equal(failed.S.switchingSession, false);
console.log('PASS conversation switch: one history render, direct target, workspace refresh, stale switch ignored, failed open');
