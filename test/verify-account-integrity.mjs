import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-account-integrity-');
const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
const bridge = new PiBridge(new HaloStore(path.join(fixture.dir, 'settings.json')));
const provider = 'openai-codex';
const authFile = path.join(fixture.dir, '.pi', 'agent', 'auth.json');
const credential = (accountId, version = 1, expires = Date.now() + 3600000) => ({
  type: 'oauth', accountId, access: `${accountId}-access-${version}`, refresh: `${accountId}-refresh-${version}`, expires,
});
const writeLive = value => fs.writeFileSync(authFile, JSON.stringify({ [provider]: value }));
const readLive = () => JSON.parse(fs.readFileSync(authFile, 'utf8'))[provider];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let refresh = async value => credential(value.accountId, 2);
let onQuota = async () => {};
let locked = Promise.resolve();
bridge.modelRuntime = {
  credentials: {
    modify(_provider, update) {
      const result = locked.then(async () => {
        const value = await update(readLive());
        writeLive(value);
        return value;
      });
      locked = result.catch(() => {});
      return result;
    },
  },
  refresh: async () => {},
  getProviders: () => [{ id: provider, auth: { oauth: { refresh: (...args) => refresh(...args) } } }],
};
const originalFetch = globalThis.fetch;
const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const originalProxy = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
for (const key of proxyKeys) delete process.env[key];
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'https://chatgpt.com/backend-api/wham/usage', 'No unexpected network requests');
  const id = options.headers['ChatGPT-Account-Id'];
  await onQuota(id);
  const used = id === 'A' ? 50 : id === 'B' ? 25 : 10;
  return { status: 200, json: async () => ({ rate_limit: { primary_window: { used_percent: used, reset_at: 100, limit_window_seconds: 18000 } } }) };
};

try {
  const oldA = credential('A', 1, 1), freshA = credential('A', 2);
  const a = bridge.vault.upsert(provider, oldA), b = bridge.vault.upsert(provider, credential('B'));
  writeLive(freshA); // The SDK refreshed the active account independently of Halo's vault.
  await bridge.authAccountSwitch(provider, b.id);
  await bridge.authAccountSwitch(provider, a.id);
  assert.deepEqual(readLive(), freshA);
  assert.deepEqual(bridge.vault.find(provider, a.id).credential, freshA);
  a.credential = oldA;
  await bridge.authAccountSwitch(provider, a.id);
  assert.deepEqual(readLive(), freshA, 'Switching the current identity also keeps the latest stored token');

  // A CLI login into another identity must not overwrite the previously active account's vault entry.
  const external = credential('external');
  writeLive(external);
  await bridge.authAccountSwitch(provider, b.id);
  assert.deepEqual(a.credential, freshA);
  assert.ok(bridge.vault.list(provider).some(entry => entry.credential?.accountId === 'external'));

  const quotaStarted = deferred(), quotaRelease = deferred();
  onQuota = async id => { if (id === 'B') { quotaStarted.resolve(); await quotaRelease.promise; } };
  const switchB = bridge.authAccountSwitch(provider, b.id);
  await quotaStarted.promise;
  const switchA = bridge.authAccountSwitch(provider, a.id);
  await Promise.resolve();
  assert.equal(readLive().accountId, 'B', 'Later switch waits for the earlier account operation');
  quotaRelease.resolve();
  const [resultB, resultA] = await Promise.all([switchB, switchA]);
  assert.equal(resultB.quota.windows[0].remaining, 0.75);
  assert.equal(resultA.quota.windows[0].remaining, 0.5);
  assert.equal(readLive().accountId, 'A');
  assert.equal(bridge.vault.data.active[provider], a.id);
  onQuota = async () => {};
  await assert.rejects(bridge.authAccountSwitch(provider, 'missing'), /账户不存在/);
  await bridge.authAccountSwitch(provider, b.id);

  const c = bridge.vault.upsert(provider, credential('C', 1, 1));
  const refreshing = deferred(), refreshRelease = deferred();
  let refreshCount = 0;
  refresh = async value => {
    assert.equal(value.accountId, 'C');
    refreshCount++;
    refreshing.resolve();
    await refreshRelease.promise;
    return credential('C', 2);
  };
  const quotas = bridge.authAccountsQuota(provider);
  await refreshing.promise;
  const switchC = bridge.authAccountSwitch(provider, c.id);
  await Promise.resolve();
  assert.equal(readLive().accountId, 'B', 'Switch waits for a dormant account token refresh');
  refreshRelease.resolve();
  await Promise.all([quotas, switchC]);
  assert.equal(refreshCount, 1);
  assert.equal(readLive().refresh, 'C-refresh-2');
  assert.equal(c.credential.refresh, 'C-refresh-2');

  const wrongIdentity = bridge.vault.upsert(provider, credential('D', 1, 1));
  refresh = async () => credential('unexpected');
  await assert.rejects(bridge.authAccountSwitch(provider, wrongIdentity.id), /账户身份不一致/);
  assert.equal(readLive().accountId, 'C', 'A mismatched refresh cannot replace the current credential');
  assert.equal(wrongIdentity.credential.accountId, 'D');
  await bridge.authAccountSwitch(provider, b.id);

  const modelQuotaStarted = deferred(), modelQuotaRelease = deferred();
  onQuota = async id => { if (id === 'B') { modelQuotaStarted.resolve(); await modelQuotaRelease.promise; } };
  const oldQuota = bridge.modelQuota(provider, true);
  await modelQuotaStarted.promise;
  const newestSwitch = bridge.authAccountSwitch(provider, a.id);
  modelQuotaRelease.resolve();
  await Promise.all([oldQuota, newestSwitch]);
  assert.equal((await bridge.modelQuota(provider)).windows[0].remaining, 0.5,
    'A previous account quota request cannot overwrite the switched account cache');

  const loginGateStarted = deferred(), loginGateRelease = deferred();
  onQuota = async () => { loginGateStarted.resolve(); await loginGateRelease.promise; };
  const blockingQuota = bridge.modelQuota(provider, true);
  await loginGateStarted.promise;
  const originalRunLogin = bridge._authRun;
  let loginStarted = false;
  bridge._authRun = async () => { loginStarted = true; };
  const canceledLogin = assert.rejects(bridge.authLogin(provider, 'oauth'), /已取消/);
  bridge.authCancel();
  loginGateRelease.resolve();
  await Promise.all([blockingQuota, canceledLogin]);
  assert.equal(loginStarted, false, 'A canceled queued login cannot start after a slow quota request');
  bridge._authRun = originalRunLogin;
  onQuota = async () => {};

  // Providers such as Anthropic return opaque tokens without accountId. There is no
  // reliable way to merge a CLI-refreshed token into an old identity; archive it and
  // refuse stale copies unless their provider refresh succeeds before auth is changed.
  const opaque = (name, version) => ({ type: 'oauth', access: `${name}-opaque-access-${version}`,
    refresh: `${name}-opaque-refresh-${version}`, expires: Date.now() + 3600000 });
  const opaqueOld = bridge.vault.upsert(provider, opaque('old-account', 1));
  const opaqueOther = bridge.vault.upsert(provider, opaque('other-account', 1));
  const opaqueFresh = opaque('old-account', 2);
  writeLive(opaqueFresh);
  refresh = async value => {
    if (value.refresh === opaqueOld.credential.refresh) throw new Error('refresh token already rotated');
    if (value.refresh.startsWith('other-account-')) return opaque('other-account', 2);
    return opaque('old-account', 3);
  };
  await bridge.authAccountSwitch(provider, opaqueOther.id);
  const archived = bridge.vault.list(provider).find(entry => entry.credential?.refresh === opaqueFresh.refresh);
  assert.ok(archived, 'Unknown refreshed identity is preserved as a separate usable account');
  assert.notEqual(archived.id, opaqueOld.id);
  await assert.rejects(bridge.authAccountSwitch(provider, opaqueOld.id), /already rotated/);
  assert.equal(readLive().refresh, 'other-account-opaque-refresh-2');
  assert.equal(opaqueOld.credential.refresh, 'old-account-opaque-refresh-1');
  await bridge.authAccountSwitch(provider, archived.id);
  assert.equal(readLive().refresh, 'old-account-opaque-refresh-3');
  assert.equal(bridge.vault.find(provider, archived.id).credential.refresh, readLive().refresh);

  const editing = bridge.vault.upsert(provider, credential('E', 1, 1));
  const editRefreshStarted = deferred(), editRefreshRelease = deferred();
  refresh = async value => { editRefreshStarted.resolve(); await editRefreshRelease.promise; return credential(value.accountId, 2); };
  const switchingEdited = bridge.authAccountSwitch(provider, editing.id);
  await editRefreshStarted.promise;
  const captureAfterSwitch = bridge.authAccountCapture(provider, 'Captured after switch');
  const removeAfterSwitch = bridge.authAccountRemove(provider, editing.id);
  assert.ok(bridge.vault.find(provider, editing.id), 'Removing an account waits for its token switch to finish');
  editRefreshRelease.resolve();
  const [, captured, removed] = await Promise.all([switchingEdited, captureAfterSwitch, removeAfterSwitch]);
  assert.equal(captured.id, editing.id, 'Capture observes the completed switch, not the previous identity');
  assert.equal(removed.removed, true);
  assert.equal(readLive().refresh, 'E-refresh-2');
  assert.equal(bridge.vault.find(provider, editing.id), null);
  console.log('PASS rotated OAuth capture; opaque/external identity safety; serialized switches and quota cache; refresh failure recovery');
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalProxy)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await bridge.dispose();
  fixture.cleanup();
}
