import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVideoProviders, VIDEO_PROVIDERS, videoModelDefaults, validateVideoOptions } from '../src/main/video-providers.mjs';
import { VideoSettings } from '../src/main/video-settings.mjs';
import { VideoGeneration } from '../src/main/video-generation.mjs';

const key = 'fixture-apimart-secret', calls = [], image = 'data:image/png;base64,YWJj';
let credits = 2.75;
let reply, taskStatus = 'completed', taskURL = ['https://cdn.example.test/result.mp4'];
const provider = createVideoProviders({ fetchImpl: async (url, init) => {
  assert.equal(new URL(url).origin, 'https://api.apimart.ai');
  assert.equal(init.headers.Authorization, `Bearer ${key}`);
  calls.push({ url, init });
  if (reply) return Response.json(reply);
  if (url.endsWith('/balance')) { assert.equal(init.method, 'GET'); return Response.json({ success: true, remain_balance: 0 }); }
  if (url.endsWith('/uploads/images')) {
    assert.ok(init.body instanceof FormData); assert.equal(init.headers['Content-Type'], undefined);
    assert.equal(init.body.get('file').type, 'image/png');
    return Response.json({ url: 'https://upload.apimart.ai/first.png' });
  }
  if (url.includes('/tasks/')) return Response.json({ code: 200, data: { status: taskStatus, credits_cost: credits, cost: 99, result: { videos: [{ url: taskURL }] } } });
  assert.ok(url.endsWith('/videos/generations'));
  return Response.json({ code: 200, data: [{ status: 'submitted', task_id: 'task-fixture-1' }] });
} }).apimart;
assert.equal((await provider.test(key)).message, '连接成功');
assert.equal(calls.length, 1, 'Connection test must not create a paid task');
reply = { success: true, remain_balance: 2, remain_credits: 19.875 };
assert.deepEqual(await provider.balance(key), { available: true, amount: 19.875, unit: 'Credits', scope: 'account' });
assert.ok(calls.at(-1).url.endsWith('/v1/user/balance'), 'Account balance must not use token quota endpoint');
reply = { success: true, remain_balance: 0 };
assert.equal((await provider.balance(key)).amount, 0);
reply = { success: true, remain_balance: 1.2345 };
assert.equal((await provider.balance(key)).amount, 12.345);
reply = { success: true };
await assert.rejects(provider.balance(key), /有效账户余额/);
reply = undefined;
for (const model of VIDEO_PROVIDERS.apimart.models) {
  const options = videoModelDefaults('apimart', model);
  validateVideoOptions('apimart', options);
  for (const firstFrame of VIDEO_PROVIDERS.apimart.modelOptions[model].supportsFirstFrame ? [undefined, image] : [undefined]) {
    assert.equal(await provider.create(key, { ...options, prompt: 'fixture', firstFrame }), 'task-fixture-1');
    const body = JSON.parse(calls.at(-1).init.body);
    assert.equal(body.model, model); assert.equal(typeof body.duration, 'number');
    assert.ok(!JSON.stringify(body).includes('data:'), 'Local first frames must be uploaded before submission');
    if (model === 'kling-v3') { assert.equal(body.mode, 'std'); assert.equal(body.resolution, undefined); }
    if (model === 'MiniMax-H3') assert.equal(body.resolution, '768P');
    if (firstFrame) {
      if (model.startsWith('seedance-')) { assert.equal(body.image_with_roles[0].role, 'first_frame'); assert.equal(body.size, 'adaptive'); }
      else if (model === 'MiniMax-H3' || model.endsWith('-official')) assert.equal(body.first_frame_image, 'https://upload.apimart.ai/first.png');
      else assert.deepEqual(body.image_urls, ['https://upload.apimart.ai/first.png']);
      if (model.startsWith('viduq3-') || model === 'wan2.6' || model.startsWith('sora-')) assert.equal(body.aspect_ratio, undefined);
    }
  }
}
await assert.rejects(provider.create(key, { ...videoModelDefaults('apimart', 'veo3.1-lite'), firstFrame: image }), /不支持首帧/);
for (const [from, to] of Object.entries({ pending: 'queued', submitted: 'queued', processing: 'running', completed: 'succeeded', failed: 'failed', cancelled: 'cancelled' })) {
  taskStatus = from; assert.equal((await provider.query(key, 'task-fixture-1')).status, to);
}
taskStatus = 'completed';
assert.deepEqual((await provider.query(key, 'task-fixture-1')).usage, { amount: 2.75, unit: 'Credits' });
credits = 0; assert.equal((await provider.query(key, 'task-fixture-1')).usage.amount, 0);
credits = 1.1440000000000001;
const settled = await provider.query(key, 'task-fixture-1');
assert.equal(settled.usage.amount, 1.144);
assert.equal(settled.billing.source, 'credits_cost');
assert.equal(settled.billing.credits_cost, credits, 'Keep original platform numeric field for reconciliation');
taskStatus = 'processing';
assert.equal((await provider.query(key, 'task-fixture-1')).usage, undefined, 'Pending quote is not settled usage');
taskStatus = 'completed';
credits = undefined;
assert.equal((await provider.query(key, 'task-fixture-1')).billing.source, 'cost_usd_x10');
credits = 2.75;
assert.equal((await provider.query(key, 'task-fixture-1')).url, taskURL[0]);
taskURL = 'https://cdn.example.test/result.mp4';
assert.equal((await provider.query(key, 'task-fixture-1')).url, taskURL);
taskURL = undefined;
await assert.rejects(provider.query(key, 'task-fixture-1'), /下载地址/);
await assert.rejects(provider.query(key, '../balance'), /任务 ID/);
reply = { success: false, message: `invalid ${key}` };
await assert.rejects(provider.test(key), error => !error.message.includes(key) && error.message.includes('已隐藏'));
reply = { code: 200, data: [] };
await assert.rejects(provider.create(key, { ...videoModelDefaults('apimart'), prompt: 'fixture' }), /勿自动重新提交/);
reply = undefined; taskURL = 'https://cdn.example.test/result.mp4';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-apimart-'));
try {
  const settings = new VideoSettings(path.join(root, 'settings.json'), { seal: v => Buffer.from(v).toString('base64'), unseal: v => Buffer.from(v, 'base64').toString() });
  settings.save({ provider: 'apimart', apiKey: key, model: 'seedance-2.5', setDefault: true });
  settings.save({ provider: 'minimax' });
  const service = new VideoGeneration(settings, path.join(root, 'jobs.json'), { confirmGeneration: async () => true, providers: { apimart: provider }, pollMs: 1, fetchImpl: async (_url, init) => {
    assert.equal(init.headers, undefined, 'CDN must never receive API keys');
    return new Response(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]));
  } });
  const before = calls.filter(c => c.url.endsWith('/videos/generations')).length;
  const result = await service.run('fixture-call', { action: 'generate', prompt: 'fixture' }, root);
  assert.deepEqual(result.usage, { amount: 2.75, unit: 'Credits' });
  assert.deepEqual(service.jobs()[0].usage, result.usage);
  assert.equal(result.provider, 'apimart'); assert.equal(result.model, 'seedance-2.5'); assert.ok(fs.existsSync(result.file));
  await service.run('fixture-call', { action: 'generate', prompt: 'fixture' }, root);
  assert.equal(calls.filter(c => c.url.endsWith('/videos/generations')).length, before + 1);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('PASS APIMart models, per-model payloads, uploads, task states, key redaction, default routing and credential-free downloads');
