import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { initReleaseHistory } from '../src/renderer/js/release-history.mjs';
import { bundledReleases } from '../src/renderer/js/release-history-data.mjs';

// Exercise the real preload contract without starting Electron or opening user data.
const invocations = [];
let preload;
runInNewContext(readFileSync(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8'), {
  require: name => {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld: (_name, api) => { preload = api; } },
      ipcRenderer: { invoke: (...args) => { invocations.push(args); return Promise.resolve(); } },
      webUtils: {},
    };
  },
});
await preload.releaseHistory();
await preload.releaseHistory(true);
await preload.releaseHistory({ force: true });
assert.deepEqual(invocations, [
  ['halo:release-history', false], ['halo:release-history', true], ['halo:release-history', false],
]);

// A small DOM surface drives the real controller, including rendered retained notes.
const ownerDocument = { defaultView: { matchMedia: () => ({ matches: true }) } };
function element(tagName = 'div') {
  const attributes = new Map(), listeners = new Map();
  return {
    tagName, ownerDocument, children: [], dataset: {}, textContent: '',
    scrollTop: 0, clientHeight: 0, offsetTop: 0, offsetHeight: 20,
    style: { setProperty() {} }, classList: { toggle() {} },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(name, listener) { listeners.set(name, listener); },
    dispatch(name) { listeners.get(name)?.(); },
    querySelector(selector) { return selector === '[aria-current]' ? this.children.find(child => child.hasCurrent) : null; },
    getBoundingClientRect() { return { top: 0 }; },
    get firstElementChild() { return this.children[0]; },
    get lastElementChild() { return this.children.at(-1); },
  };
}
ownerDocument.createElement = element;
const nodes = new Map([
  ...['releaseHistoryList', 'releaseHistoryRefresh', 'releaseHistoryNav', 'releaseHistoryStatus',
    'releaseCurrentVersion', 'releaseRepository'].map(id => [`#${id}`, element()]),
  ['[data-pane="history"]', element()],
]);
const previousObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = class { observe() {} };
const calls = [];
let response = { ok: false, error: 'GitHub 请求限流（403）' };
try {
  const controller = initReleaseHistory({ root: { querySelector: selector => nodes.get(selector) }, api: {
    releaseHistory: async force => { calls.push(force); return response; },
    appUpdateState: async () => ({ ok: true, data: { currentVersion: '1.0.11' } }),
    openExternal: async () => ({ ok: true }),
  } });
  await controller.refresh();
  assert.equal(nodes.get('#releaseCurrentVersion').textContent, '当前安装 v1.0.11');
  assert.equal(nodes.get('#releaseHistoryStatus').textContent, 'GitHub 请求限流（403），显示本地记录');
  assert.equal(nodes.get('#releaseHistoryRefresh').disabled, false);
  assert.equal(nodes.get('#releaseHistoryList').children[0].dataset.version, '1.0.11');
  assert.ok(bundledReleases.some(release => release.version === '1.0.10'));

  response = { ok: true, data: [{ version: '1.0.12', date: '2026-10-02T00:00:00Z', body: '<script>fixture</script>' }] };
  nodes.get('#releaseHistoryRefresh').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1), true, 'The explicit refresh button must bypass the cached response');
  assert.equal(nodes.get('#releaseHistoryStatus').textContent, '已同步 GitHub 正式版本');
  const article = nodes.get('#releaseHistoryList').children[0];
  assert.equal(article.dataset.version, '1.0.12');
  assert.equal(article.children[1].children[0].textContent, '<script>fixture</script>', 'Remote notes stay plain text');

  nodes.get('[data-pane="history"]').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1), false, 'Opening the page may reuse the successful cache');
  response = { ok: false, error: '无法连接 GitHub' };
  await controller.refresh(true);
  assert.equal(nodes.get('#releaseHistoryStatus').textContent, '无法连接 GitHub，显示本地记录');
  assert.equal(nodes.get('#releaseHistoryList').children[0].dataset.version, '1.0.12', 'Failed retries retain the latest successful notes');
} finally {
  if (previousObserver === undefined) delete globalThis.ResizeObserver;
  else globalThis.ResizeObserver = previousObserver;
}
console.log('PASS release history UI: real errors, forced refresh, bundled notes, retained records and preload contract');
