import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const input = { value: '', selectionStart: 0, selectionEnd: 0, setAttribute() {}, removeAttribute() {} };
const menu = { hidden: true };
const options = { replaceChildren() {}, innerHTML: '' };
const context = vm.createContext({
  S: { state: { cwd: 'C:/project' } },
  $: selector => ({ '#input': input, '#mentionMenu': menu, '#mentionOptions': options, '.mention-heading': {} })[selector],
  $$: () => [], highlightMention() {}, updateCommandSuggestions() {},
});
vm.runInContext(source.slice(source.indexOf('let mentionItems ='), source.indexOf('function updateCommandSuggestions(')), context);
vm.runInContext(source.slice(source.indexOf('function handleMentionKey('), source.indexOf('const compactingSessions =')), context);
for (const text of ['@"C:/project/video.mp4" 加上中文字幕', '@"C:/project/video.mp4"', '@"C:/some folder/video.mp4" 继续']) {
  input.value = text; input.selectionStart = input.selectionEnd = text.length;
  menu.hidden = false;context.updateMentions();assert.equal(menu.hidden, true, 'Completed references do not reopen completion');
}
for (const text of ['@missing', '@"C:/missing file']) {
  input.value = text; input.selectionStart = input.selectionEnd = text.length;
  context.updateMentions();assert.equal(menu.hidden, false);
  let prevented = false;
  assert.equal(context.handleMentionKey({ key: 'Enter', preventDefault() { prevented = true; }, stopPropagation() {} }), false);
  assert.equal(prevented, false, 'No results must not swallow Enter');assert.equal(menu.hidden, true);
}
console.log('PASS mentions: completed quoted paths, prose, partial quoted paths and empty-result Enter fallback');
