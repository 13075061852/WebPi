import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parsePackagePage, searchPackageNames } from '../src/main/package-name-search.mjs';
const card = (name, desc = 'fixture') => `<article data-package-card="true" data-package-name="${name}" data-package-types="extension" data-package-date="1788765291179"><p class="packages-desc">${desc}</p><div class="packages-meta"><span>author</span></div><a href="https://github.com/test/repo">repo</a><a href="https://github.com/test/issues?package-version=1.2.3">report</a></article>`;
const html = (total, cards) => `<span class="packages-count">1-50 / ${total}</span>${cards}`;
const parsed = parsePackagePage(html(1, card('@scope/assistant', 'A &amp; B &lt;tag&gt;')));
assert.equal(parsed.objects[0].package.description, 'A & B <tag>');
assert.equal(parsed.objects[0].package.version, '1.2.3');
assert.throws(() => parsePackagePage('<html>gateway error</html>'), /格式/);
assert.throws(() => parsePackagePage(html(1, '')), /解析/);
const emptyPage = '<span class="packages-count">0 / 5394</span><p class="packages-empty">No packages match this filter.</p>';
assert.deepEqual(parsePackagePage(emptyPage), { total: 0, objects: [] });
assert.throws(() => parsePackagePage('<span class="packages-count">unexpected</span>'), /格式/);
assert.equal(parsePackagePage(html(56, card('fixture')).replace(' / 56', ' / 56 (of 5394)')).total, 56);
let emptyCalls = 0;
assert.deepEqual(await searchPackageNames('keywords:pi-package,skill', 'wechat', 0, 20, async url => {
  emptyCalls++;
  assert.equal(new URL(url).searchParams.get('type'), 'skill');
  return new Response(emptyPage);
}), { total: 0, objects: [] });
assert.equal(emptyCalls, 1, 'An empty category must not fetch more pages');
let calls = 0;
const request = async url => {
  calls++; const u = new URL(url);
  assert.equal(u.origin, 'https://pi.dev'); assert.equal(u.searchParams.get('name'), 'fixture-assi');
  return new Response(html(51, u.searchParams.get('page') === '1'
    ? card('other', 'fixture-assi description match') + card('fixture-assistant-a') : card('fixture-assistant-b')));
};
const [first, concurrent] = await Promise.all([
  searchPackageNames('keywords:pi-package','fixture-assi',0,1,request),
  searchPackageNames('keywords:pi-package','fixture-assi',0,1,request),
]);
assert.equal(calls, 2); assert.deepEqual(first, concurrent); assert.equal(first.total, 2);
const second = await searchPackageNames('keywords:pi-package','fixture-assi',1,1,request);
assert.equal(second.objects[0].package.name, 'fixture-assistant-b'); assert.equal(calls, 2);
let browseCalls = 0;
const browse = await searchPackageNames('keywords:pi-package,theme','',40,20,async url => {
  browseCalls++; const u = new URL(url); assert.equal(u.searchParams.get('type'), 'theme');
  const start = (Number(u.searchParams.get('page')) - 1) * 50;
  return new Response(html(100, Array.from({length:50},(_,i)=>card('theme-'+(start+i))).join('')));
});
assert.equal(browseCalls, 2); assert.equal(browse.objects.length, 20);
assert.equal(browse.objects[0].package.name, 'theme-40'); assert.equal(browse.objects.at(-1).package.name, 'theme-59');
// Exercise the actual renderer flow, including stale counts during a category switch.
const source = readFileSync(new URL('../src/renderer/js/app.js', import.meta.url), 'utf8');
const elements = Object.fromEntries(['#pkgMarket', '#pkgPageInfo', '#pkgPrev', '#pkgNext'].map(id => [id, {}]));
let resolveSearch;
const state = { pkgType: 'skill', pkgQuery: 'wechat', pkgTotal: 5, pkgItems: [{}] };
const context = vm.createContext({
  S: state, $: id => elements[id], esc: String, normPkgSource: String,
  window: { halo: { pkgSearch: () => new Promise(resolve => { resolveSearch = resolve; }) } },
});
vm.runInContext(source.slice(source.indexOf('const PAGE_SIZE = 20;'), source.indexOf('const normPkgSource =')), context);
const pending = vm.runInContext('loadMarket(1)', context);
assert.equal(state.pkgTotal, 0);
assert.equal(elements['#pkgPageInfo'].textContent, '');
assert.equal(elements['#pkgNext'].disabled, true);
resolveSearch({ ok: true, data: { items: [], total: 0 } });
await pending;
assert.match(elements['#pkgMarket'].innerHTML, /当前分类下没有匹配的搜索结果/);
state.pkgQuery = 'network-failure';
const failed = vm.runInContext('loadMarket(1)', context);
resolveSearch({ ok: false, error: '网络断开' });
await failed;
assert.match(elements['#pkgMarket'].innerHTML, /加载失败：网络断开/);
// Prefetch the next five pages, reuse in-flight requests and keep filters isolated.
const pageCalls = [];
context.window.halo.pkgSearch = async args => {
  pageCalls.push(args);
  return { ok: true, data: { items: [], total: 200 } };
};
state.pkgQuery = 'prefetch'; state.pkgType = 'all';
await vm.runInContext('loadMarket(1)', context);
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
await flush();
assert.deepEqual(pageCalls.map(x => x.from), [0, 20, 40, 60, 80, 100]);
await vm.runInContext('loadMarket(2)', context); await flush();
assert.deepEqual(pageCalls.map(x => x.from), [0, 20, 40, 60, 80, 100, 120], 'Cached navigation only fetches the new lookahead page');
state.pkgType = 'theme';
await vm.runInContext('loadMarket(10)', context); await flush();
assert.equal(pageCalls.at(-1).type, 'theme');
assert.equal(pageCalls.at(-1).from, 180, 'Last page must not prefetch beyond the total');
let releasePage;
const racingCalls = [];
state.pkgQuery = 'race'; state.pkgType = 'all';
context.window.halo.pkgSearch = args => {
  racingCalls.push(args.from);
  if (args.from === 20) return new Promise(resolve => { releasePage = resolve; });
  return Promise.resolve({ ok: true, data: { items: [], total: 200 } });
};
await vm.runInContext('loadMarket(1)', context);
const nextPage = vm.runInContext('loadMarket(2)', context);
assert.deepEqual(racingCalls, [0, 20], 'Navigation must share the pending prefetch');
state.pkgType = 'installed';
releasePage({ ok: true, data: { items: [], total: 200 } });
await nextPage; await flush();
assert.deepEqual(racingCalls, [0, 20], 'Switching category stops the obsolete prefetch queue');
assert.equal(state.pkgPage, 2);
console.log('PASS official package search: parsing, name-only matches, pagination, category, request sharing, cache, format errors');
