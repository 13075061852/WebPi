import { syncConversationSelection } from '../src/renderer/js/conversation-selection.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const start = source.indexOf('async function openSession(file) {');
const code = source.slice(start, source.indexOf('async function newSession(', start));
const clickStart = source.indexOf('button.addEventListener("click", async () => {', source.indexOf('async function loadProjects()'));
const click = source.slice(clickStart, source.indexOf('});', clickStart));
assert.ok(click.includes('openSession(session.file)'));
assert.ok(!click.includes('switchProject('), 'Conversation selection must not open the project default conversation first');

function harness() {
  const calls = [], pending = [];
  const S = { state: { cwd: 'C:/one' }, sessionSwitchSeq: 0 };
  const record = name => () => calls.push(name);
  const context = vm.createContext({ setConversationWaiting() {}, conversationMotion: { cancel() {}, reveal() {} }, S,
    normPath: p => String(p || "").replaceAll("\\", "/").toLowerCase(), Promise,
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
  assert.equal(h.calls.includes('clear'), false, 'Keep the visible conversation until the target is ready');
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


// Slow runtime creation must paint the new conversation immediately, including
// when it supersedes an in-progress history restore. Failures restore old nodes.
function newHarness() {
  const old = { text: 'previous conversation' };
  const messages = { childNodes: [old], scrollTop: 140,
    replaceChildren(...nodes) { this.childNodes = nodes; } };
  const busy = new Set(), pending = [];
  const S = { sessionSwitchSeq: 0, switchingSession: true, historyHost: {} };
  const context = vm.createContext({ setConversationWaiting() {}, conversationMotion: { cancel() {}, reveal() {} }, S,
    normPath: p => String(p || "").replaceAll("\\", "/").toLowerCase(),
    $: selector => selector === '#messages' ? messages : {
      setAttribute: key => busy.add(key), removeAttribute: key => busy.delete(key) },
    window: { halo: { newSession: () => new Promise(resolve => pending.push(resolve)) } },
    clearChat() { messages.replaceChildren(); }, applyState: state => { S.state = state; },
    loadQuota() {}, toast() {}, loadSessions: async () => {},
    finishSessionSwitch() { S.switchingSession = false; busy.delete("aria-busy"); },
  });
  vm.runInContext(source.slice(source.indexOf('async function newSession('), source.indexOf('function finishSessionSwitch()')), context);
  return { context, S, messages, busy, pending, old };
}
for (const success of [true, false]) {
  const h = newHarness();
  const task = h.context.newSession();
  assert.equal(h.pending.length, 1, 'New action must not be silently dropped during history restore');
  assert.equal(h.messages.childNodes.length, 0, 'Clear visible history before slow IPC resolves');
  assert.equal(h.busy.has('aria-busy'), true);
  await h.context.newSession();
  assert.equal(h.pending.length, 1, 'Repeated clicks must not create duplicate runtimes');
  h.pending[0](success ? { ok: true, data: { sessionId: 'new' } } : { ok: false, error: 'failed' });
  await task;
  assert.equal(h.S.switchingSession, false);
  assert.equal(h.S.newSessionPending, false);
  assert.equal(h.busy.has('aria-busy'), false);
  assert.equal(h.messages.childNodes.length, success ? 0 : 1);
  if (!success) assert.equal(h.messages.childNodes[0], h.old);
}
console.log('PASS new conversation: immediate empty view, supersede restore, duplicate suppression and failure rollback');


const buttons = ['C:\\sessions\\first.jsonl', 'C:/sessions/second.jsonl'].map(file => {
  const classes = new Set(), attributes = new Map();
  return { dataset: { conversationFile: file }, classes, attributes,
    classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name) },
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
});
const root = { querySelectorAll: () => buttons };
for (const file of ['c:/sessions/first.jsonl', 'C:\\sessions\\second.jsonl', '']) {
  syncConversationSelection(file, root);
  assert.equal(buttons.filter(b => b.classes.has('active')).length, file ? 1 : 0);
  assert.equal(buttons.filter(b => b.attributes.has('aria-current')).length, file ? 1 : 0);
  if (file) assert.equal(buttons[file.includes('first') ? 0 : 1].classes.has('active'), true);
}
console.log('PASS selection updates without rebuilding rows, normalizes Windows paths and clears previous selection');

const projectNewStart = source.indexOf('$(".project-new", group).addEventListener("click", async () => {');
const projectNew = source.slice(projectNewStart, source.indexOf('});', projectNewStart));
assert.ok(projectNew.includes('newSession(p.cwd)'));
assert.ok(!projectNew.includes('switchProject('), 'Project new must not restore an old conversation first');
