import assert from 'node:assert/strict';
import { probeConnectivity } from '../src/main/connectivity.mjs';
let calls = 0;
const success = await probeConnectivity('google', async (url, options) => {
  calls++;
  assert.equal(url, 'https://www.google.com/');
  assert.equal(options.method, 'HEAD');
  assert.equal(options.credentials, 'omit');
  return {ok:true,status:200};
});
assert.equal(success.status, 'available');
assert.ok(success.ms >= 0);
for (const code of [401, 403, 405, 429, 503]) {
  const result = await probeConnectivity('openai', async () => ({ok:false,status:code}));
  assert.equal(result.status, 'connected', 'HTTP responses must not be classified as network failures');
  assert.equal(result.code, code);
}
assert.equal((await probeConnectivity('github', async () => { throw Error('net::ERR_NAME_NOT_RESOLVED'); })).error, '域名解析失败');
const timeout = await probeConnectivity('youtube', (_, options) => new Promise((resolve, reject) => {
  options.signal.addEventListener('abort', () => reject(Error('aborted')), {once:true});
}), 5);
assert.equal(timeout.error, '连接超时');
await assert.rejects(probeConnectivity('https://localhost/', async () => { calls++; }), /不支持/);
assert.equal(calls, 1);
console.log('PASS connectivity: success, HTTP restriction, DNS failure, timeout, fixed targets');
