import assert from 'node:assert/strict';
import { createReleaseHistory } from '../src/main/release-history.mjs';
const release = { tag_name: 'v1.0.7', published_at: '2026-09-18T09:23:53Z', body: '更新内容' };
let calls = 0;
const load = createReleaseHistory({ fetchImpl: async () => {
  calls++;
  return { ok: true, json: async () => [release, { ...release, draft: true }, { ...release, prerelease: true }, { ...release, tag_name: '<script>' }] };
} });
const [first, second] = await Promise.all([load(), load()]);
assert.deepEqual(first, second);
assert.equal(first.length, 1);
assert.equal(first[0].version, '1.0.7');
assert.equal(first[0].url, 'https://github.com/13075061852/WebPi/releases/tag/v1.0.7');
await load(); assert.equal(calls, 1, 'Concurrent requests and cached requests must not repeatedly hit GitHub');
let attempts = 0, clock = 0;
const retry = createReleaseHistory({ now: () => clock, fetchImpl: async url => {
  if (!url.startsWith('https://api.github.com/')) throw Error('Offline fallback unavailable');
  return ++attempts === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => [release] };
} });
await assert.rejects(retry(), /429/);
clock = 60001;
assert.equal((await retry()).length, 1, 'A failure must allow retry');
await assert.rejects(createReleaseHistory({ offline: true, fetchImpl: () => { throw Error('must not fetch'); } })(), /离线/);
let pages = 0;
const paginated = createReleaseHistory({ fetchImpl: async () => ({ ok: true, json: async () => ++pages === 1 ? Array(100).fill(release) : [] }) });
assert.equal((await paginated()).length, 100);
assert.equal(pages, 2);
await load(true); assert.equal(calls, 2, 'Manual refresh must bypass the successful cache');
await load({ force: true }); assert.equal(calls, 2, 'Only an explicit Boolean can force refresh');

const feed = entries => `<feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`;
const entry = (version, notes = '&lt;p&gt;Release notes&lt;/p&gt;', href = `https://github.com/13075061852/WebPi/releases/tag/v${version}`) =>
  `<entry><updated>2026-10-01T09:35:02Z</updated><link rel="alternate" href="${href}"/><content type="html">${notes}</content></entry>`;
const requests = [];
let simulatedNow = 1000;
const fallback = createReleaseHistory({ now: () => simulatedNow, fetchImpl: async (url, options) => {
  requests.push(url);
  assert.ok(options.signal);
  assert.equal(options.headers['User-Agent'], 'Pi-Halo');
  if (url.startsWith('https://api.github.com/')) return { ok: false, status: 403, headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' }) };
  if (url.endsWith('/latest')) return { ok: true, json: async () => ({ tag_name: 'v1.0.12' }) };
  return { ok: true, text: async () => feed([
    entry('1.0.12', '&lt;h2&gt;新版本&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;修复同步 &amp;amp; 代理&lt;/li&gt;&lt;/ul&gt;'),
    entry('1.0.11'), entry('1.0.10'), entry('1.0.99'), entry('1.0.12-test.1'),
    entry('1.0.9', 'bad repo', 'https://example.com/releases/tag/v1.0.9'),
  ]) };
} });
const recovered = await fallback();
assert.deepEqual(recovered.map(item => item.version), ['1.0.12', '1.0.11', '1.0.10']);
assert.match(recovered[0].body, /新版本\n\n- 修复同步 & 代理/);
assert.ok(!recovered[0].body.includes('<li>'));
await fallback(); assert.equal(requests.length, 3, 'Fallback results are cached');
await fallback(true); assert.equal(requests.length, 5, 'Force refresh uses public endpoints during API cooldown');
simulatedNow = 120001;
await fallback(true); assert.equal(requests.filter(url => url.startsWith('https://api.github.com/')).length, 2, 'API retry respects the reset time');

for (const badFeed of ['<bad/>', '<!DOCTYPE feed><feed/>', 'x'.repeat(2 * 1024 * 1024 + 1), feed([entry('1.0.10')])]) {
  const invalid = createReleaseHistory({ fetchImpl: async url => url.includes('api.github.com')
    ? { ok: false, status: 403 } : url.endsWith('/latest')
      ? { ok: true, json: async () => ({ tag_name: 'v1.0.11' }) } : { ok: true, text: async () => badFeed } });
  await assert.rejects(invalid(), /403.*备用入口.*发布记录/);
}
const timedOut = createReleaseHistory({ fetchImpl: async () => { throw new DOMException('deadline', 'TimeoutError'); } });
await assert.rejects(timedOut(), /超时.*备用入口.*超时/);
const disconnected = createReleaseHistory({ fetchImpl: async () => { throw Error('fetch failed'); } });
await assert.rejects(disconnected(), /系统代理/);
console.log('PASS release history: official API, force/cache, concurrency, retry cooldown, public feed fallback, stable filtering, malformed feed, offline and specific errors');
