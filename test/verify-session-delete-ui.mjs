import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const code = source.slice(source.indexOf('const sessionDeletions = new Map();'), source.indexOf('\nconst normPath'));
function harness() {
  const rows = [], requests = [], timers = [];
  let historyResolve, historyStarted = false;
  const S = { state: { sessionFile: 'current' }, sessions: [{ file: 'current' }, { file: 'other' }], sessionSwitchSeq: 0 };
  const context = vm.createContext({ S, CONFIRM_RESET_MS: 2600, normPath: p => String(p || '').toLowerCase(),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    document: { querySelectorAll: () => rows.filter(row => !row.removed).map(row => row.main) },
    window: { halo: { deleteSession: file => new Promise(resolve => requests.push({ file, resolve })) } },
    loadSessions: async () => {}, refreshServers: async () => {}, toast() {}, clearChat() {},
    restoreHistory: () => { historyStarted = true; return new Promise(resolve => { historyResolve = resolve; }); },
  });
  vm.runInContext(code, context);
  const row = file => {
    const classes = new Set(), buttons = [{ disabled: false }, { disabled: false }];
    const item = { file, classes, buttons, classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
      setAttribute() {}, removeAttribute() {}, querySelectorAll: () => buttons, querySelector: () => buttons[1], remove() { this.removed = true; } };
    item.main = { dataset: { conversationFile: file }, closest: () => item };
    rows.push(item);
    context.syncSessionDeleteControls({ file }, item, buttons[1]);
    return item;
  };
  return { S, requests, timers, row, click: item => context.requestDeleteSession({ file: item.file }, item, item.buttons[1]),
    visible: file => vm.runInContext(`sessionNotDeleted({file:${JSON.stringify(file)}})`, context),
    history: () => historyStarted, releaseHistory: () => historyResolve() };
}
const h = harness(), first = h.row('current');
await h.click(first);
assert.equal(h.requests.length, 0, 'First click only confirms');
first.removed = true;
const rebuilt = h.row('current');
assert.ok(rebuilt.classes.has('confirm'), 'Background redraw preserves confirmation');
const deleting = h.click(rebuilt);
assert.ok(rebuilt.buttons.every(button => button.disabled), 'Pending rows cannot be opened or submitted again');
await h.click(h.row('current'));
assert.equal(h.requests.length, 1, 'Redraw and repeated clicks cannot duplicate deletion');
h.requests[0].resolve({ ok: true, data: { switched: true } });
await new Promise(resolve => setImmediate(resolve));
assert.ok(h.history(), 'Replacement history is still restoring');
assert.ok(rebuilt.removed, 'Deleted row disappears before replacement history finishes');
assert.equal(h.visible('current'), false, 'A stale list response cannot restore the deleted row');
h.releaseHistory(); await deleting;

const f = harness(), other = f.row('other');
await f.click(other);
const failed = f.click(other);
f.requests[0].resolve({ ok: false, error: 'busy' }); await failed;
assert.ok(!other.removed && other.buttons.every(button => !button.disabled), 'Failure leaves the row available for retry');
assert.equal(f.visible('other'), true);
await f.click(other);
f.timers.at(-1)();
assert.ok(!other.classes.has('confirm'), 'Confirmation still expires');
await f.click(other);
const removed = f.click(other);
f.requests[1].resolve({ ok: true, data: { switched: false } }); await removed;
assert.ok(other.removed && !f.history(), 'Deleting another conversation preserves current history');

const r = harness(), current = r.row('current');
await r.click(current);
const raced = r.click(current);
r.S.sessionSwitchSeq++;
r.requests[0].resolve({ ok: true, data: { switched: true } }); await raced;
assert.equal(r.history(), false, 'A later user switch owns the visible conversation');
console.log('PASS deletion confirmation survives redraw, duplicate guard, immediate removal, stale lists, failure retry and focus races');
