import assert from 'node:assert/strict';
import { checkPackageUpdates } from '../src/main/package-updates.mjs';
let active = 0, peak = 0;
const packages = Array.from({ length: 13 }, (_, i) => ({ source: i ? `npm:fixture-${i}@1.0.0` : 'npm:@scope/fixture@1.0.0', version: '1.0.0', desc: 'local' }));
await checkPackageUpdates(packages, { concurrency: 3, request: async url => {
  active++; peak = Math.max(peak, active);
  assert.ok(!url.includes('@1.0.0'));
  if (url.includes('%40scope')) assert.match(url, /%40scope\/fixture\/latest$/);
  await new Promise(resolve => setTimeout(resolve, 2)); active--;
  return new Response(JSON.stringify({ version: '2.0.0', description: 'remote', author: 'author' }));
} });
assert.equal(peak, 3);
assert.ok(packages.every(pkg => pkg.update && pkg.latest === '2.0.0' && pkg.desc === 'local'));
let aborted = false;
const hanging = [{ source: 'npm:hanging', version: '1' }];
await checkPackageUpdates(hanging, { timeoutMs: 15, request: async (_url, { signal }) => {
  signal.addEventListener('abort', () => { aborted = true; });
  return { ok: true, json: () => new Promise(() => {}) };
} });
assert.equal(aborted, true, 'Timeout also bounds reading the response body');
assert.equal(hanging[0].version, '1'); assert.equal(hanging[0].update, undefined);
await checkPackageUpdates(hanging, { request: async () => { throw Error('offline'); } });
console.log('PASS bounded registry concurrency, scoped/versioned names, body timeout/abort and local metadata on network failure');
