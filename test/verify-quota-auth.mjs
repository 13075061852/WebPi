import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';
import { quotaAuthExpired, quotaResponseError } from '../src/main/quota-auth.mjs';

for (const status of [401, 403, 429, 500, 503]) {
  const plain = quotaResponseError({ status }, { error: 'request rejected' }, 'usage');
  assert.equal(quotaAuthExpired(plain), status === 401, `Generic HTTP ${status}`);
  const explicit = quotaResponseError({ status }, { error: { code: 'token_expired' } }, 'usage');
  assert.equal(quotaAuthExpired(explicit), status < 429, `Explicit auth failure with HTTP ${status}`);
}
for (const message of ['invalid_grant', 'Refresh token is invalid', 'The access token has expired',
  'refresh token already rotated', 'OpenAI Codex token refresh failed (401): Unauthorized',
  'OpenAI Codex token refresh response missing fields: {}', 'Failed to extract accountId from token']) {
  assert.equal(quotaAuthExpired(new Error(message)), true, message);
}
for (const message of ['fetch failed', 'request timed out', 'quota 数据缺失',
  'OpenAI Codex token refresh failed (503): invalid_token',
  'OpenAI Codex token refresh failed (403): Forbidden',
  'OpenAI Codex token refresh failed (429): rate limited']) {
  assert.equal(quotaAuthExpired(new Error(message)), false, message);
}

const fixture = isolatePi('halo-quota-auth-');
const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
const bridge = new PiBridge(new HaloStore(path.join(fixture.dir, 'settings.json')));
const provider = 'openai-codex';
const authFile = path.join(fixture.dir, '.pi', 'agent', 'auth.json');
const realNow = Date.now, originalFetch = globalThis.fetch;
let now = realNow();
Date.now = () => now;
const credential = (accountId, version = 1, expires = now + 3600000) => ({
  type: 'oauth', accountId, access: `fixture-${accountId}-${version}`, refresh: `fixture-refresh-${accountId}-${version}`, expires,
});
const writeLive = value => fs.writeFileSync(authFile, JSON.stringify(value ? { [provider]: value } : {}));
const readLive = () => JSON.parse(fs.readFileSync(authFile, 'utf8'))[provider];
const expired = { kind: 'windows', error: true, authExpired: true };
let response = { status: 200, body: { rate_limit: { primary_window: { used_percent: 25 } } } };
let requests = 0, refreshes = 0, writes = 0;
let refresh = async value => credential(value.accountId, 2);
bridge.modelRuntime = {
  credentials: {
    async modify(_provider, update) {
      const value = await update(readLive());
      writes++;
      writeLive(value);
      return value;
    },
  },
  refresh: async () => {},
  getProviders: () => [{ id: provider, auth: { oauth: { refresh: value => { refreshes++; return refresh(value); } } } }],
};
globalThis.fetch = async url => {
  assert.ok(['https://chatgpt.com/backend-api/wham/usage',
    'https://api.openai.com/v1/dashboard/billing/credit_grants'].includes(String(url)), 'No real or unexpected endpoint may be called');
  requests++;
  if (response instanceof Error) throw response;
  return new Response(JSON.stringify(response.body), { status: response.status });
};
const healthy = () => { response = { status: 200, body: { rate_limit: { primary_window: { used_percent: 25 } } } }; };
const fail = (status, body = { error: 'request rejected' }) => { response = { status, body }; };

try {
  const a = bridge.vault.upsert(provider, credential('A'));
  const b = bridge.vault.upsert(provider, credential('B'));
  writeLive(a.credential);
  const initial = await bridge.modelQuota(provider, true);
  assert.equal(initial.windows[0].remaining, .75);

  for (const status of [403, 429, 500, 503]) {
    fail(status);
    assert.deepEqual(await bridge.modelQuota(provider, true), initial, `HTTP ${status} retains the healthy same-account value`);
  }
  response = new Error('fetch failed');
  assert.deepEqual(await bridge.modelQuota(provider, true), initial, 'Network errors retain the last healthy quota');

  fail(401);
  assert.deepEqual(await bridge.modelQuota(provider, true), expired, 'Confirmed expired auth overrides old successful quota');
  assert.deepEqual((await bridge.authAccountsQuota(provider)).find(row => row.id === a.id).quota, expired,
    'Active account chip agrees with the quota bar');
  healthy();
  assert.equal((await bridge.modelQuota(provider, true)).windows[0].remaining, .75, 'A later successful refresh clears expired state');
  assert.equal((await bridge.authAccountsQuota(provider)).find(row => row.id === a.id).quota.authExpired, undefined);

  fail(403, { error: { code: 'invalid_token', message: 'The access token is expired' } });
  assert.deepEqual(await bridge.modelQuota(provider, true), expired, 'Explicit 403 invalid credentials are not confused with a WAF rejection');
  healthy();
  await bridge.modelQuota(provider, true);
  const beforeMissing = requests;
  writeLive({ ...a.credential, access: '' });
  assert.deepEqual(await bridge.modelQuota(provider, true), expired, 'Missing access token is explicit auth failure');
  writeLive({ ...a.credential, accountId: '' });
  assert.deepEqual(await bridge.modelQuota(provider, true), expired, 'Missing account identity is explicit auth failure');
  writeLive(null);
  assert.deepEqual(await bridge.modelQuota(provider, true), expired, 'Missing stored account is explicit auth failure');
  fs.writeFileSync(authFile, '{invalid-json');
  assert.deepEqual(await bridge.modelQuota(provider, true), expired, 'Malformed account information is explicit auth failure');
  assert.equal(requests, beforeMissing, 'Incomplete credentials never reach the network');

  writeLive(credential('A', 1, 1));
  const beforeRefresh = refreshes;
  assert.equal((await bridge.modelQuota(provider, true)).windows[0].remaining, .75);
  assert.equal(refreshes, beforeRefresh + 1, 'Normal access expiry refreshes OAuth instead of falsely expiring the account');
  assert.equal(readLive().access, 'fixture-A-2', 'Rotated active token is saved under the runtime credential lock');
  assert.equal(bridge.vault.find(provider, a.id).credential.access, 'fixture-A-2', 'Vault uses the same rotated token');

  writeLive(credential('A', 2, 1));
  const beforeFailure = readLive(), beforeWrites = writes;
  refresh = async () => { throw new Error('OpenAI Codex token refresh failed (400): invalid_grant'); };
  assert.deepEqual(await bridge.modelQuota(provider, true), expired);
  assert.deepEqual(readLive(), beforeFailure, 'Failed refresh must not erase stored credentials');
  assert.equal(writes, beforeWrites, 'A failed refresh does not commit a credential write');
  refresh = async value => credential(value.accountId, 3);
  assert.equal((await bridge.modelQuota(provider, true)).windows[0].remaining, .75, 'OAuth recovery clears expired state');

  writeLive(credential('B'));
  response = new Error('fetch failed');
  assert.deepEqual(await bridge.modelQuota(provider, true), { kind: 'windows', error: true },
    'External identity changes cannot reuse a different account cached value');
  healthy();
  await bridge.modelQuota(provider, true);
  fail(401);
  const switched = await bridge.authAccountSwitch(provider, a.id);
  assert.deepEqual(switched.quota, expired, 'Account switching returns its auth failure instead of null');
  assert.deepEqual(await bridge.modelQuota(provider), expired, 'Switch result and quota bar share the same state');
  now += 61000;
  assert.ok((await bridge.authAccountsQuota(provider)).every(row => row.quota.authExpired), 'Batch account queries classify auth errors too');
  healthy();
  const recovered = await bridge.authAccountSwitch(provider, b.id);
  assert.equal(recovered.quota.windows[0].remaining, .75);
  assert.equal((await bridge.modelQuota(provider)).authExpired, undefined, 'Switching to a healthy account clears the state');

  fs.writeFileSync(authFile, JSON.stringify({ openai: { type: 'api_key', key: 'fixture-openai-key' } }));
  fail(401, { error: { type: 'authentication_error', message: 'This endpoint only supports session keys; API keys are not supported.' } });
  assert.deepEqual(await bridge.modelQuota('openai', true), { kind: 'context' },
    'Legacy best-effort billing permissions do not expire an otherwise valid API key');
  fail(401, { error: { code: 'invalid_api_key', message: 'Invalid API key provided.' } });
  assert.deepEqual(await bridge.modelQuota('openai', true), { kind: 'balance', error: true, authExpired: true },
    'Explicit credential failure from best-effort billing still expires the account');
  console.log('PASS quota auth classification, healthy-cache invalidation, recovery, locked OAuth refresh, account chips/switches and best-effort billing permissions');
} finally {
  Date.now = realNow;
  globalThis.fetch = originalFetch;
  await bridge.dispose();
  fixture.cleanup();
}
