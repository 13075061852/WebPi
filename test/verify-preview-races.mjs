import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const start = source.indexOf('async function setPreview(p, force) {');
const end = source.indexOf('\nfunction renderThinkList()', start);
const pending = new Map();
const body = { innerHTML: '' }, name = {}, mode = {};
const context = vm.createContext({
  portPreviewRequest: 0, previewService: null, selectedPortKey: null,
  S: { previewFile: null, previewMode: 'source' },
  updatePortSelection() {},
  $: selector => ({ '#pvBody': body, '#pvName': name, '#pvMode': mode })[selector],
  window: { halo: { readFile: p => new Promise(resolve => pending.set(p, resolve)) } },
  rich: text => text, esc: text => text, previewURL: text => text,
});
vm.runInContext(source.slice(start, end), context);
for (const old of ['old.md', 'old.html', 'old.txt']) {
  context.S.previewFile = null;
  const older = context.setPreview(old);
  const newer = context.setPreview('new.md');
  pending.get('new.md')({ data: { content: 'latest preview' } });
  await newer;
  pending.get(old)({ data: { content: 'stale preview' } });
  await older;
  assert.match(body.innerHTML, /latest preview/);
  assert.doesNotMatch(body.innerHTML, /stale/);
  assert.equal(name.textContent, 'new.md');
}
context.S.previewFile = null;
const first = context.setPreview('same.md');
await context.setPreview('same.md');
pending.get('same.md')({ data: { content: 'same file completes' } });
await first;
assert.match(body.innerHTML, /same file completes/);
console.log('PASS stale markdown, HTML source and text reads cannot replace the current preview; repeat selection completes');
