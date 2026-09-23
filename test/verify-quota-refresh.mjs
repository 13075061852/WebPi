import assert from 'node:assert/strict';
import { createQuotaRefreshQueue } from '../src/renderer/js/quota-refresh.mjs';

let provider = 'openai-codex';
const calls = [], applied = [], pending = [];
const flush = () => new Promise(resolve => setImmediate(resolve));
const queue = createQuotaRefreshQueue({
  currentProvider: () => provider,
  request: (id, force) => {
    calls.push({ id, force });
    return new Promise(resolve => pending.push(resolve));
  },
  apply: (id, data) => applied.push({ id, data }),
});

const first = queue.enqueue(provider, true);
await flush();
const second = queue.enqueue(provider, true);
const third = queue.enqueue(provider, true);
assert.equal(calls.length, 1, 'An in-flight check must not drop later tool steps');
pending.shift()({ ok: true, data: { remaining: 82 } });
await first;
await flush();
assert.equal(calls.length, 2);
pending.shift()({ ok: true, data: { remaining: 81 } });
await second;
await flush();
assert.equal(calls.length, 3);
pending.shift()({ ok: true, data: { remaining: 80 } });
await third;
assert.deepEqual(applied.map(item => item.data.remaining), [82, 81, 80]);
assert.ok(calls.every(call => call.force), 'Each step must bypass the quota cache');

const oldAccount = queue.enqueue(provider, true);
await flush();
queue.invalidate();
const newAccount = queue.enqueue(provider, true);
pending.shift()({ ok: true, data: { remaining: 70 } });
await oldAccount;
await flush();
assert.equal(applied.at(-1).data.remaining, 80, 'Old account quota must not replace the new account');
pending.shift()({ ok: true, data: { remaining: 95 } });
await newAccount;
assert.equal(applied.at(-1).data.remaining, 95);

provider = 'deepseek';
await queue.enqueue('openai-codex', true);
assert.equal(calls.length, 5, 'Inactive provider checks must be skipped');
console.log('PASS every step refreshes, overlapping checks queue, old account results stay stale, inactive providers skip');
