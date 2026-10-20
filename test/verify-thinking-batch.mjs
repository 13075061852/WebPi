import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { OutputRate } from '../src/renderer/js/output-rate.mjs';
const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const updateStart = source.indexOf('function onMessageUpdate(ev) {');
const updateEnd = source.indexOf('\nfunction onMessageEnd(', updateStart);
assert.ok(updateStart >= 0 && updateEnd > updateStart, 'Thinking fixture must isolate the current message-update handler');
const updates = source.slice(updateStart, updateEnd);
const collapse = source.slice(source.indexOf('function collapseThink() {'), source.indexOf('/* 正文块：'));
const frames = new Map(); let seq = 0, renders = 0;
const t = { buf: '', body: { scrollHeight: 10 }, preview: {}, label: {}, el: { open: true }, t0: Date.now() };
const turn = {};
const context = vm.createContext({
  S: { thinking: t }, ensureThink: () => t,
  ensureTurn: () => turn, OutputRate,
  requestAnimationFrame: callback => { frames.set(++seq, callback); return seq; },
  cancelAnimationFrame: id => frames.delete(id),
  streamRender: (body, text) => { renders++; body.text = text; },
  thinkPreviewText: text => text.slice(0, 96), scrollDown() {},
});
vm.runInContext(collapse + updates, context);
for (let i = 0; i < 100; i++) context.onMessageUpdate({ type: 'thinking_delta', delta: 'x' });
assert.equal(frames.size, 1);
assert.equal(renders, 0);
const callback = [...frames.values()][0]; frames.clear(); callback();
assert.equal(renders, 1);
assert.equal(t.body.text.length, 100);
context.onMessageUpdate({ type: 'thinking_delta', delta: 'final' });
context.collapseThink();
assert.equal(frames.size, 0);
assert.equal(t.body.text, 'x'.repeat(100) + 'final');
assert.equal(context.S.thinking, null);
assert.equal(t.el.open, false);
console.log('PASS 100 thinking deltas coalesce into one render, and collapse flushes final text');
