import assert from 'node:assert/strict';
import { createReleaseHistoryFetch } from '../src/main/release-history-fetch.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

const appReady = deferred(), proxyReady = deferred();
const created = [], configurations = [], requests = [];
let readyCalls = 0, transport;
const ownedSession = {
  setProxy(config) { configurations.push(config); return proxyReady.promise; },
  async fetch(url, options) {
    assert.equal(this, ownedSession, 'Electron session.fetch must retain its receiver');
    requests.push({ url, options });
    return `response:${url}`;
  },
};
transport = createReleaseHistoryFetch({
  app: { whenReady() { readyCalls++; return appReady.promise; } },
  session: {
    fromPartition(partition, options) {
      created.push({ partition, options });
      assert.equal(transport.ownsSession(ownedSession), true, 'session-created must be recognized before assignment');
      return ownedSession;
    },
  },
});
const otherSession = {};
assert.equal(readyCalls, 0, 'the factory must remain lazy before use');
assert.equal(transport.ownsSession(otherSession), false);
assert.equal(transport.ownsSession(undefined), false);
const controller = new AbortController(), headers = { Accept: 'application/atom+xml' };
const first = transport.fetch('https://example.invalid/one', {
  headers, signal: controller.signal, credentials: 'include', method: 'GET',
});
const second = transport.fetch('https://example.invalid/two');
assert.equal(readyCalls, 1, 'concurrent requests must share initialization');
assert.equal(created.length, 0, 'Electron sessions must wait for app.whenReady');
appReady.resolve();
await turn();
assert.deepEqual(created, [{ partition: 'halo-release-history', options: { cache: false } }]);
assert.deepEqual(configurations, [{ mode: 'system' }]);
assert.equal(requests.length, 0, 'requests must wait until system proxy configuration is ready');
assert.equal(transport.ownsSession(ownedSession), true);
assert.equal(transport.ownsSession(otherSession), false);
proxyReady.resolve();
assert.deepEqual(await Promise.all([first, second]), [
  'response:https://example.invalid/one', 'response:https://example.invalid/two',
]);
assert.equal(requests[0].options.headers, headers);
assert.equal(requests[0].options.signal, controller.signal);
assert.equal(requests[0].options.method, 'GET');
assert.equal(requests[0].options.credentials, 'omit', 'history requests must not send session credentials');
assert.equal(requests[1].options.credentials, 'omit');
await transport.fetch('https://example.invalid/three');
assert.equal(readyCalls, 1);
assert.equal(created.length, 1);
assert.equal(configurations.length, 1);

let attempts = 0, failedFetches = 0;
const retrySession = {
  async setProxy(config) {
    assert.deepEqual(config, { mode: 'system' });
    if (++attempts === 1) throw Error('proxy initialization failed');
  },
  async fetch() { failedFetches++; return 'retried'; },
};
const retry = createReleaseHistoryFetch({
  app: { async whenReady() {} },
  session: { fromPartition() { return retrySession; } },
});
const failed = await Promise.allSettled([retry.fetch('https://example.invalid'), retry.fetch('https://example.invalid')]);
assert.equal(attempts, 1, 'initialization failure must be shared by pending requests');
for (const result of failed) {
  assert.equal(result.status, 'rejected');
  assert.match(result.reason.message, /proxy initialization failed/);
}
assert.equal(failedFetches, 0);
assert.equal(retry.ownsSession(retrySession), true, 'a failed setup session must remain excluded from app proxy routing');
assert.equal(await retry.fetch('https://example.invalid'), 'retried');
assert.equal(attempts, 2, 'failed initialization must permit a later retry');
assert.equal(failedFetches, 1);
assert.equal(retry.ownsSession(otherSession), false);

console.log('PASS release history transport: isolated system session, lazy readiness, ownership, concurrent setup, request options and retry');
