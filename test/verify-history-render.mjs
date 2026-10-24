import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const start = source.indexOf('  await new Promise((resolve, reject)', source.indexOf('async function restoreHistory('));
assert.ok(start > 0);
const block = source.slice(start, source.indexOf('\n  if (switchSeq', start));
async function run({ failAt = -1, cancel = false } = {}) {
  const callbacks = [], restored = [], historyHost = {};
  const S = { sessionSwitchSeq: 1, historyHost };
  const context = vm.createContext({
    S, historyHost, switchSeq: 1, msgs: Array.from({ length: 1203 }, (_, index) => index),
    performance: { now: () => 0 },
    requestAnimationFrame() { throw Error('Hidden renderer frames never arrive'); },
    setTimeout(callback, delay) { assert.equal(delay, 0); callbacks.push(callback); },
    restoreOne(message) {
      if (message === failAt) throw Error('Invalid historical message');
      restored.push(message);
    },
  });
  const result = vm.runInContext(`(async () => { ${block} })()`, context)
    .then(() => ({ ok: true }), error => ({ error }));
  assert.equal(restored.length, failAt === 0 ? 0 : 24, 'Initial batch stays bounded');
  if (cancel) S.sessionSwitchSeq++;
  while (callbacks.length) callbacks.shift()();
  return { ...(await result), S, restored };
}
const complete = await run();
assert.ok(complete.ok);
assert.equal(complete.restored.length, 1203, 'Full history restores without any animation frames');
for (const failAt of [0, 30]) {
  const failed = await run({ failAt });
  assert.match(failed.error.message, /Invalid historical message/);
  assert.equal(failed.S.historyHost, null, 'Both initial and later batch failures reject rather than hanging startup');
}
const cancelled = await run({ cancel: true });
assert.ok(cancelled.ok);
assert.equal(cancelled.restored.length, 24, 'Switching away cancels remaining history work');
console.log('PASS 1203-message hidden-window restoration, bounded batches, first/later error propagation and switch cancellation');
