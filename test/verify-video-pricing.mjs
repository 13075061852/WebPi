import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VideoPricing, estimateApimart, parseApimartPricing } from '../src/main/video-pricing.mjs';
import { videoModelDefaults } from '../src/main/video-providers.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/apimart-video-pricing.json', import.meta.url), 'utf8'));
const model = id => fixture.models.find(x => x.id === id);
const options = (id, resolution, duration = 5) => ({ provider: 'apimart', ...videoModelDefaults('apimart', id), resolution, duration });
const estimate = (id, resolution, duration = 5) => estimateApimart(model(id), options(id, resolution, duration));
assert.equal(estimate('seedance-2.0-mini', '720P').total, 1.144);
assert.equal(estimate('seedance-2.0-mini', '720P').rate, 0.2288);
assert.equal(estimate('seedance-2.0-mini', '480P', 10).total, 1.056);
assert.equal(estimate('MiniMax-H3', '768P').total, 2.856);
assert.equal(estimate('MiniMax-H3', '2K').total, 4.572);
assert.equal(estimate('sora-2-pro', '720P').total, 12);
assert.equal(estimate('sora-2-pro', '1080P').rate, 5.6);
assert.equal(estimate('kling-v3', '1080P').total, 4.48);
assert.equal(estimate('veo3.1-fast', '720P', 8).total, 1.4);
assert.equal(estimate('veo3.1-fast', '4K', 8).total, 6.4);
assert.equal(estimate('veo3.1-fast-official', '720P', 8).total, 5.12);
assert.equal(estimate('wan2.6', '720P').total, 2.5);
assert.equal(estimate('seedance-2.5', '720P').pricing.settlement, 'tokens');
assert.equal(estimateApimart(model('grok-imagine-video-1.5'), {...options('grok-imagine-video-1.5', '720P'), inputImageCount: 1}).total, 5.68);
assert.equal(estimateApimart(model('MiniMax-H3'), {...options('MiniMax-H3', '768P'), inputImageCount: 1}).total, 2.856);
// Promotional prices can change independently of the legacy discount_percent field.
const changed = structuredClone(model('seedance-2.0-mini'));
changed.discount_percent = 20;
changed.fixed_prices.items.find(x => x.key === '720P').after_discount = 0.02;
assert.equal(estimateApimart(changed, options(changed.id, '720P')).total, 1);
for (const change of [d => delete d.fixed_prices.items.find(x => x.key === '720P').after_discount,
  d => { d.fixed_prices.unit = 'tokens'; }, d => { d.fixed_prices.dimension = 'duration'; },
  d => { d.fixed_prices.items = [{key:'default',after_discount:0.1}]; }]) {
  const copy = structuredClone(model('seedance-2.0-mini')); change(copy);
  assert.equal(estimateApimart(copy, options(copy.id, '720P')), null);
}
const flight = '0:' + JSON.stringify({ pricing: fixture.models }) + '\n';
const html = '<script>throw Error("never execute page scripts")</script>' + [flight.slice(0, 81), flight.slice(81)].map(chunk => '<script>self.__next_f.push(' + JSON.stringify([1,chunk]) + ')</script>').join('');
assert.equal(parseApimartPricing(html).size, 18);
assert.equal(parseApimartPricing('<script>self.__next_f.push(eval("bad"))</script>').size, 0);
let count = 0, now = 0, fail = false;
const pricing = new VideoPricing({ now: () => now, fetchImpl: async (url, init) => {
  count++; assert.equal(init.method, 'GET'); assert.equal(init.headers, undefined);
  assert.equal(url, 'https://apimart.ai/pricing');
  return new Response(fail ? 'shape changed' : html);
} });
const mini = options('seedance-2.0-mini', '720P');
const [first, second, list] = await Promise.all([pricing.estimate(mini), pricing.estimate({...mini,duration:10}), pricing.models({provider:'apimart',resolution:'720P'})]);
assert.equal(first.total, 1.144); assert.equal(second.total, 2.288); assert.equal(count, 1);
assert.equal(list.length, 18); assert.ok(list.every(x => x.available));
assert.equal(list.find(x => x.model === 'seedance-2.0-mini').rate, 0.2288);
assert.equal((await pricing.estimate({...mini,provider:'minimax',model:'MiniMax-H3',resolution:'768P'})).available, false);
now = 300001; await pricing.estimate(mini); assert.equal(count, 2);
now = 600002; fail = true; assert.equal((await pricing.estimate(mini)).available, false);
fail = false; assert.equal((await pricing.estimate(mini)).available, true);
assert.deepEqual(await pricing.models({provider:'minimax'}), []);
console.log('PASS official after-discount prices, 18 model tiers, materials, per-call units, no guessed discounts, safe page parsing and shared cache');
