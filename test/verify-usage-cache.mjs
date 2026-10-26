import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageSessionReader } from '../src/main/usage-session-reader.mjs';
import { usageSummary } from '../src/main/usage-summary.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-usage-cache-'));
const reader = new UsageSessionReader();
const now = new Date().toISOString();
const entry = (output = 100) => JSON.stringify({ type: 'message', timestamp: now,
  message: { role: 'assistant', provider: 'openai-codex', model: 'fixture', usage: { input: 100, output, cost: { total: 0 } } } });
const file = path.join(root, 'one.jsonl');
let price = 10;
const runtime = { getModel: () => ({ cost: { input: price, output: price, cacheRead: 0, cacheWrite: 0 } }) };
const summary = days => usageSummary(root, days ?? 30, runtime, reader);
try {
  // Include whitespace in headers and malformed/torn lines from a live append.
  fs.writeFileSync(file, [JSON.stringify({ type: 'session', cwd: root }, null, 0),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'first' } }), entry(), '{torn',
    JSON.stringify({ type: 'session_info', name: 'Renamed conversation' })].join('\n'));
  const cold = await summary();
  assert.equal(cold.sessions, 1); assert.equal(cold.totals.calls, 1); assert.equal(cold.totals.cost, .002);
  assert.equal(cold.sessionDetails[0].cwd, root); assert.equal(cold.sessionDetails[0].name, 'Renamed conversation');
  const warm = await summary();
  assert.deepEqual(warm, cold); assert.equal(reader.reads, 1, 'Unchanged files must not be reopened or parsed');
  price = 20;
  assert.equal((await summary()).totals.cost, .004, 'Model pricing is recomputed from the current catalog');
  assert.equal(reader.reads, 1);
  fs.appendFileSync(file, '\n' + entry(200));
  assert.equal((await summary()).totals.calls, 2); assert.equal(reader.reads, 2);
  const second = path.join(root, 'two.jsonl'); fs.writeFileSync(second, entry());
  assert.equal((await summary()).sessions, 2, 'New files appear without restarting');
  fs.rmSync(file);
  assert.equal((await summary()).sessions, 1); assert.equal(reader.cache.has(file), false);
  // Same-size replacement must invalidate even when a caller restores mtime.
  const stamp = fs.statSync(second); fs.writeFileSync(second, entry(200)); fs.utimesSync(second, stamp.atime, stamp.mtime);
  assert.equal((await summary()).totals.output, 200);
  assert.equal((await summary(-1)).totals.calls, 0, 'The moving date window is applied on every read');
  const small = new UsageSessionReader({ maxFiles: 1, maxRows: 1 });
  await usageSummary(root, 30, runtime, small);
  assert.ok(small.cache.size <= 1 && small.rows <= 1);
  await Promise.all([summary(), summary()]);
  assert.equal(reader.rows, [...reader.cache.values()].reduce((sum, item) => sum + item.rows.length, 0));
  console.log('PASS usage cache hits, current pricing/date window, append/new/delete/replace invalidation and bounded memory');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
