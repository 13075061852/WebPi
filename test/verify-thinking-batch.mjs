import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const updates = source.slice(source.indexOf('function onMessageUpdate(ev) {'), source.indexOf('\nfunction onMessageEnd(msg)'));
const collapse = source.slice(source.indexOf('function collapseThink() {'), source.indexOf('/* 正文块：'));
const frames = new Map(); let seq = 0, renders = 0;
const t = { buf: '', body: { scrollHeight: 10 }, preview: {}, label: {}, el: { open: true }, t0: Date.now() };
const context = vm.createContext({
  S: { thinking: t }, ensureThink: () => t,
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
