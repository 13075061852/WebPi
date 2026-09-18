import assert from 'node:assert/strict';
import { parsePackagePage, searchPackageNames } from '../src/main/package-name-search.mjs';
const card = (name, desc = 'fixture') => `<article data-package-card="true" data-package-name="${name}" data-package-types="extension" data-package-date="1788765291179"><p class="packages-desc">${desc}</p><div class="packages-meta"><span>author</span></div><a href="https://github.com/test/repo">repo</a><a href="https://github.com/test/issues?package-version=1.2.3">report</a></article>`;
const html = (total, cards) => `<span class="packages-count">1-50 / ${total}</span>${cards}`;
const parsed = parsePackagePage(html(1, card('@scope/assistant', 'A &amp; B &lt;tag&gt;')));
assert.equal(parsed.objects[0].package.description, 'A & B <tag>');
assert.equal(parsed.objects[0].package.version, '1.2.3');
assert.throws(() => parsePackagePage('<html>gateway error</html>'), /格式/);
assert.throws(() => parsePackagePage(html(1, '')), /解析/);
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
console.log('PASS official package search: parsing, name-only matches, pagination, category, request sharing, cache, format errors');
