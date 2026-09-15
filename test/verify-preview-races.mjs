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
  $: selector => ({ '#pvBody': body, '#pvName': name, '#pvMode': mode, '#btnOpenFile': {} })[selector],
  window: { halo: { readFile: p => new Promise(resolve => pending.set(p, resolve)) } },
  document: { documentElement: { dataset: { projectCwd: 'C:/project' } } },
  esc: text => text,
});
vm.runInContext(fs.readFileSync('src/renderer/js/markdown.js', 'utf8'), context);
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
const nested = context.setPreview('docs/README.md');
pending.get('docs/README.md')({ data: { path: 'C:/project/docs/README.md', content: '![figure](./images/figure.png)\n[guide](../guide.md)' } });
await nested;
assert.match(body.innerHTML, /src="halo-preview:\/\/local\/C%3A\/project\/docs\/images\/figure.png"/);
assert.match(body.innerHTML, /href="halo-preview:\/\/local\/C%3A\/project\/guide.md"/);
assert.doesNotMatch(body.innerHTML, /__chat__/);
console.log('PASS preview race protection and Markdown paths relative to the previewed document');
