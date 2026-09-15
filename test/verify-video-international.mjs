import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';
import { VideoHTTP } from '../src/main/video-http.mjs';
import { createInternationalProviders, INTERNATIONAL_VIDEO_SPECS } from '../src/main/video-international.mjs';

const key = 'fixture-only-video-key';
const firstFrame = 'data:image/png;base64,aGVsbG8=';
const id = 'c174bc91-cd49-44b8-a682-813c51c6c6c2';
const operation = `models/veo-3.1-generate-preview/operations/${id}`;
const requests = [];
let response = {}, status = 200;
const providers = createInternationalProviders(new VideoHTTP({ fetchImpl: async (url, init) => {
  requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
  return Response.json(response, { status });
} }));
const recent = () => requests.at(-1);

// Read-only connection checks exercise real transport headers without creating paid jobs.
response = { models: [{ name: 'models/veo-3.1-generate-preview' }] };
await providers.google.test({ apiKey: key });
assert.equal(recent().url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
assert.equal(recent().init.headers['x-goog-api-key'], key);
assert.equal(recent().init.headers.Authorization, undefined);
response = { creditBalance: 0 };
await providers.runway.test(key);
assert.equal(recent().url, 'https://api.dev.runwayml.com/v1/organization');
assert.equal(recent().init.headers['X-Runway-Version'], '2024-11-06');
assert.equal(recent().init.headers.Authorization, `Bearer ${key}`);
response = { data: [], has_more: false };
await providers.luma.test(key);
assert.equal(recent().url, 'https://agents.lumalabs.ai/v1/files?limit=1');
assert.ok(requests.every(request => request.init.method === 'GET' && request.body === undefined));

const googleOptions = { ...INTERNATIONAL_VIDEO_SPECS.google.defaults, prompt: 'A sunrise over the sea', firstFrame };
response = { name: operation };
const controller = new AbortController();
assert.equal(await providers.google.create(key, googleOptions, controller.signal), operation);
assert.deepEqual(recent().body, {
  instances: [{ prompt: googleOptions.prompt, image: { mimeType: 'image/png', bytesBase64Encoded: 'aGVsbG8=' } }],
  parameters: { sampleCount: 1, durationSeconds: 8, resolution: '720p', aspectRatio: '16:9' },
});
// Compare with the official SDK's actual serialized request, which differs from some REST guide examples.
const googleWireBody = recent().body;
const originalFetch = globalThis.fetch;
try {
  let sdkBody;
  globalThis.fetch = async (_url, init) => {
    sdkBody = JSON.parse(init.body);
    return Response.json({ name: operation });
  };
  const sdk = new GoogleGenAI({ apiKey: key, vertexai: false });
  await sdk.models.generateVideos({ model: googleOptions.model,
    source: { prompt: googleOptions.prompt, image: { imageBytes: 'aGVsbG8=', mimeType: 'image/png' } },
    config: { numberOfVideos: 1, durationSeconds: 8, resolution: '720p', aspectRatio: '16:9' },
  });
  assert.deepEqual(googleWireBody, sdkBody, 'Veo REST payload must match the official SDK conversion');
} finally { globalThis.fetch = originalFetch; }
assert.ok(recent().init.signal instanceof AbortSignal);
await assert.rejects(providers.google.create(key, { ...googleOptions, duration: 6, resolution: '1080P' }), /8 秒/);
await assert.rejects(providers.google.create(key, { ...googleOptions, model: 'veo-3.1-lite-generate-preview', resolution: '4K' }), /参数无效/);
response = { name: operation, done: false };
assert.equal((await providers.google.query(key, operation)).status, 'running');
response = { name: operation, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/123:download?alt=media' } }] } } };
const completed = await providers.google.query(key, operation);
assert.equal(completed.status, 'succeeded');
assert.deepEqual(completed.downloadHeaders, { 'x-goog-api-key': key });
assert.deepEqual(completed.downloadAuthOrigins, ['https://generativelanguage.googleapis.com']);
response = { done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['blocked'] } } };
assert.deepEqual(await providers.google.query(key, operation), { status: 'failed', error: 'blocked' });
response = { done: true, error: { message: `error ${key}` } };
assert.equal((await providers.google.query(key, operation)).error, 'error [已隐藏]');
for (const bad of ['https://example.com/steal', 'models/../../operations/key', 'models/other/operations/123', 'operations/123']) {
  await assert.rejects(providers.google.query(key, bad), /无效/);
}

const runwayOptions = { ...INTERNATIONAL_VIDEO_SPECS.runway.defaults, prompt: 'A camera circles a tree' };
response = { id };
assert.equal(await providers.runway.create(key, runwayOptions), id);
assert.equal(recent().url, 'https://api.dev.runwayml.com/v1/text_to_video');
assert.deepEqual(recent().body, { model: 'gen4.5', promptText: runwayOptions.prompt, duration: 5, ratio: '1280:720' });
await providers.runway.create(key, { ...runwayOptions, firstFrame, ratio: '9:16' });
assert.equal(recent().url, 'https://api.dev.runwayml.com/v1/image_to_video');
assert.equal(recent().body.promptImage, firstFrame);
assert.equal(recent().body.ratio, '720:1280');
await assert.rejects(providers.runway.create(key, { ...runwayOptions, model: 'gen4_turbo' }), /首帧/);
await assert.rejects(providers.runway.create(key, { ...runwayOptions, prompt: 'x'.repeat(1001) }), /1000/);
await assert.rejects(providers.runway.create(key, { ...runwayOptions, firstFrame: 'data:image/png;base64,' + 'a'.repeat(8 * 1024 * 1024) }), /5 MB/);
await assert.rejects(providers.runway.create(key, { ...runwayOptions, firstFrame: 'data:image/png;base64,' + 'a'.repeat(5_000_000) }), /编码后/);
for (const [input, expected] of Object.entries({ PENDING: 'queued', THROTTLED: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelled' })) {
  response = { status: input, output: ['https://cdn.example.test/video.mp4'], failure: `failure ${key}` };
  const result = await providers.runway.query(key, id);
  assert.equal(result.status, expected);
  assert.equal(result.error, 'failure [已隐藏]');
  assert.equal(result.downloadHeaders, undefined, 'CDN downloads must not receive Runway credentials');
}

const lumaOptions = { ...INTERNATIONAL_VIDEO_SPECS.luma.defaults, prompt: 'A bird flies across mountains', firstFrame, duration: 10 };
response = { id };
assert.equal(await providers.luma.create(key, lumaOptions), id);
assert.deepEqual(recent().body, { model: 'ray-3.2', type: 'video', prompt: lumaOptions.prompt,
  aspect_ratio: '16:9', video: { resolution: '720p', duration: '10s', keyframes: [{ data: 'aGVsbG8=', media_type: 'image/png' }], keyframe_indexes: [0] } });
assert.equal(recent().url, 'https://agents.lumalabs.ai/v1/generations');
for (const [input, expected] of Object.entries({ queued: 'queued', processing: 'running', completed: 'succeeded', failed: 'failed' })) {
  response = { state: input, output: [{ type: 'image', url: 'wrong-output' }, { type: 'video', url: 'https://cdn.example.test/luma.mp4' }], failure_reason: key };
  const result = await providers.luma.query(key, id);
  assert.equal(result.status, expected);
  assert.equal(result.url, 'https://cdn.example.test/luma.mp4');
  assert.equal(result.error, '[已隐藏]');
  assert.equal(result.downloadHeaders, undefined, 'Luma signed URLs do not need credentials');
}

// Invalid credentials, task names and unknown contracts must fail before making an unintended request.
for (const [name, provider] of Object.entries(providers)) {
  const before = requests.length;
  await assert.rejects(provider.test(''), /API Key/);
  await assert.rejects(provider.query(key, '../../organization'), /无效/);
  assert.equal(requests.length, before);
  response = {};
  await assert.rejects(provider.query(key, name === 'google' ? operation : id), /未知/);
  await assert.rejects(provider.create(key, { ...INTERNATIONAL_VIDEO_SPECS[name].defaults, prompt: 'test' }), /勿自动重新提交/);
  response = { error: { message: `bad ${key}` } }; status = 401;
  await assert.rejects(provider.test(key), error => error.status === 401 && !error.message.includes(key));
  status = 200;
}

for (const spec of Object.values(INTERNATIONAL_VIDEO_SPECS)) {
  assert.equal(new URL(spec.keyUrl).protocol, 'https:');
  assert.equal(new URL(spec.docsUrl).protocol, 'https:');
  assert.ok(spec.models.includes(spec.defaults.model));
}
console.log('PASS international video providers: read-only auth, payloads, model constraints, statuses, scoped download auth, redaction');
