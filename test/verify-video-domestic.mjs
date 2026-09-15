import assert from 'node:assert/strict';
import { DOMESTIC_VIDEO_SPECS, createDomesticProviders } from '../src/main/video-domestic.mjs';

const key = 'fixture-video-key-never-real';
const image = 'data:image/png;base64,aGVsbG8=';
const calls = [];
let response;
const http = { async request(url, options) {
  calls.push({ url, ...options });
  if (response instanceof Error) throw response;
  return structuredClone(response);
} };
const providers = createDomesticProviders(http);
const defaults = id => ({ ...DOMESTIC_VIDEO_SPECS[id].defaults, prompt: '雨后的城市与行人' });

// Auth tests must use the documented read-only operations and validate their envelopes.
const tests = {
  dashscope: { response: { data: [] }, url: 'https://dashscope.aliyuncs.com/api/v1/tasks?page_no=1&page_size=1' },
  volcengine: { response: { items: [] }, url: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks?page_num=1&page_size=1' },
  kling: { response: { code: 0, data: { result: [] } }, url: 'https://api-beijing.klingai.com/tasks' },
  vidu: { response: { remains: [] }, url: 'https://api.vidu.cn/ent/v2/credits' },
};
for (const [id, item] of Object.entries(tests)) {
  response = item.response;
  assert.equal((await providers[id].test(key)).message, '连接成功');
  assert.equal(calls.at(-1).url, item.url);
  assert.deepEqual(calls.at(-1).body, id === 'kling' ? { limit: 1 } : undefined);
  response = {};
  await assert.rejects(providers[id].test(key));
  for (const status of [400, 401, 403, 404, 429, 503]) {
    response = Object.assign(Error(`HTTP ${status}`), { status, data: { message: 'fixture rejection' } });
    await assert.rejects(providers[id].test(key), new RegExp(`HTTP ${status}`));
  }
}

response = { output: { task_id: 'wan-job', task_status: 'PENDING' } };
assert.equal(await providers.dashscope.create(key, defaults('dashscope')), 'wan-job');
assert.deepEqual(calls.at(-1).body, { model: 'wan2.7-t2v', input: { prompt: defaults('dashscope').prompt },
  parameters: { resolution: '720P', duration: 5, ratio: '16:9' } });
assert.equal(calls.at(-1).headers['X-DashScope-Async'], 'enable');
await providers.dashscope.create(key, { ...defaults('dashscope'), model: 'wan2.7-i2v', ratio: 'adaptive', firstFrame: image });
assert.deepEqual(calls.at(-1).body.input.media, [{ type: 'first_frame', url: image }]);
assert.equal(calls.at(-1).body.parameters.ratio, undefined);
await assert.rejects(providers.dashscope.create(key, { ...defaults('dashscope'), firstFrame: image }), /不支持首帧/);
await assert.rejects(providers.dashscope.create(key, { ...defaults('dashscope'), model: 'wan2.7-i2v', ratio: 'adaptive' }), /需要首帧/);
response = { output: { task_status: 'SUCCEEDED', video_url: 'https://result.example/wan.mp4' } };
assert.equal((await providers.dashscope.query(key, 'wan-job')).url, 'https://result.example/wan.mp4');
response = { output: { task_status: 'UNKNOWN' } };
assert.equal((await providers.dashscope.query(key, 'wan-job')).status, 'failed');
response = { code: 'InvalidApiKey', message: `invalid: ${key}` };
await assert.rejects(providers.dashscope.test(key), error => !error.message.includes(key) && /已隐藏/.test(error.message));

response = { id: 'ark-job' };
await providers.volcengine.create(key, { ...defaults('volcengine'), firstFrame: image });
assert.equal(calls.at(-1).body.ratio, 'adaptive');
assert.deepEqual(calls.at(-1).body.content[1], { type: 'image_url', image_url: { url: image }, role: 'first_frame' });
await providers.volcengine.create(key, { ...defaults('volcengine'), model: 'doubao-seedance-2-0-fast-260128' });
assert.equal(calls.at(-1).body.ratio, '16:9');
response = { status: 'failed', error: { code: 'BadInput', message: `rejected ${key}` } };
assert.deepEqual(await providers.volcengine.query(key, 'ark-job'), { status: 'failed', error: 'rejected [已隐藏]' });
response = { status: 'expired' };
assert.deepEqual(await providers.volcengine.query(key, 'ark-job'), { status: 'failed', error: '任务已超时' });

response = { code: 0, data: { id: 'kling-job', status: 'submitted' } };
assert.equal(await providers.kling.create(key, defaults('kling')), 'kling-job');
assert.equal(calls.at(-1).url, 'https://api-beijing.klingai.com/text-to-video/kling-3.0');
assert.deepEqual(calls.at(-1).body.settings, { resolution: '720p', duration: 5, aspect_ratio: '16:9' });
await providers.kling.create(key, { ...defaults('kling'), firstFrame: image });
assert.equal(calls.at(-1).url, 'https://api-beijing.klingai.com/image-to-video/kling-3.0');
assert.deepEqual(calls.at(-1).body.contents, [{ type: 'prompt', text: defaults('kling').prompt }, { type: 'first_frame', url: 'aGVsbG8=' }]);
assert.equal(calls.at(-1).body.settings.aspect_ratio, undefined);
response = { code: 0, data: [{ id: 'other-task', status: 'failed' }, { id: 'kling-job', status: 'succeeded',
  outputs: [{ type: 'image', url: 'https://result.example/thumb.jpg' }, { type: 'video', url: 'https://result.example/kling.mp4' }] }] };
assert.equal((await providers.kling.query(key, 'kling-job')).url, 'https://result.example/kling.mp4');
response = { code: 0, data: [] };
await assert.rejects(providers.kling.query(key, 'kling-job'), /未返回该任务/);
response = { code: 1002, message: `bad ${key}` };
await assert.rejects(providers.kling.test(key), /bad \[已隐藏\]/);

response = { task_id: 'vidu-job', state: 'created' };
await providers.vidu.create(key, defaults('vidu'));
assert.equal(calls.at(-1).headers.Authorization, `Token ${key}`);
assert.equal(calls.at(-1).body.aspect_ratio, '16:9');
await providers.vidu.create(key, { ...defaults('vidu'), firstFrame: image });
assert.equal(calls.at(-1).url, 'https://api.vidu.cn/ent/v2/img2video');
assert.deepEqual(calls.at(-1).body.images, [image]);
assert.equal(calls.at(-1).body.aspect_ratio, undefined);
const beforeLargeImage = calls.length;
await assert.rejects(providers.vidu.create(key, { ...defaults('vidu'), firstFrame: `data:image/png;base64,${'A'.repeat(20_000_000)}` }), /20 MB/);
assert.equal(calls.length, beforeLargeImage, 'oversized Vidu requests must fail before HTTP');
response = { state: 'success', creations: [{ url: 'https://result.example/vidu.mp4' }] };
assert.equal((await providers.vidu.query(key, 'vidu-job')).status, 'succeeded');

const resultEnvelope = {
  dashscope: state => ({ output: { task_status: state } }),
  volcengine: state => ({ status: state }),
  kling: state => ({ code: 0, data: [{ id: 'fixture-id', status: state }] }),
  vidu: state => ({ state }),
};
const cases = {
  dashscope: { PENDING: 'queued', RUNNING: 'running', FAILED: 'failed', CANCELED: 'cancelled' },
  volcengine: { queued: 'queued', running: 'running', cancelled: 'cancelled' },
  kling: { submitted: 'queued', processing: 'running', failed: 'failed' },
  vidu: { created: 'queued', queueing: 'queued', processing: 'running', failed: 'failed', cancelled: 'cancelled' },
};
for (const [id, provider] of Object.entries(providers)) {
  for (const [state, expected] of Object.entries(cases[id])) {
    response = resultEnvelope[id](state);
    assert.equal((await provider.query(key, 'fixture-id')).status, expected);
  }
  response = resultEnvelope[id]('not-a-real-state');
  await assert.rejects(provider.query(key, 'fixture-id'), /未知任务状态/);
  const before = calls.length;
  for (const invalid of ['../secret', 'job?key=foo', '', 'a'.repeat(129)]) await assert.rejects(provider.query(key, invalid), /任务 ID/);
  for (const model of ['../other-endpoint', 'constructor', '__proto__']) {
    await assert.rejects(provider.create(key, { ...defaults(id), model }), /不支持的视频模型/);
  }
  await assert.rejects(provider.create(key, { ...defaults(id), duration: 999 }), /时长或比例无效/);
  assert.equal(calls.length, before, 'invalid inputs must never reach HTTP');
  response = id === 'kling' ? { code: 0 } : {};
  await assert.rejects(provider.create(key, defaults(id)), /核对任务/);
  for (const model of DOMESTIC_VIDEO_SPECS[id].models) {
    const spec = DOMESTIC_VIDEO_SPECS[id].modelOptions[model];
    assert.ok(spec.resolutions.length && spec.ratios.length);
    assert.ok(spec.durations?.length || spec.maxDuration >= spec.minDuration);
  }
}

console.log('video-domestic: official request fixtures, read-only connection checks, auth failures, status mapping and task guards passed');
