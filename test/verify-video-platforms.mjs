import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoHTTP, videoDispatcher } from '../src/main/video-http.mjs';
import { VIDEO_PROVIDERS, createVideoProviders, validateVideoOptions } from '../src/main/video-providers.mjs';
import { VideoSettings } from '../src/main/video-settings.mjs';
import { VideoGeneration } from '../src/main/video-generation.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-platforms-'));
const key = 'fixture-private-key';
const crypto = { seal: text => Buffer.from(text).toString('base64'), unseal: text => Buffer.from(text, 'base64').toString() };
const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
try {
  assert.equal(Object.keys(VIDEO_PROVIDERS).length, 10);
  assert.throws(() => validateVideoOptions('__proto__'), /不支持/);
  assert.throws(() => validateVideoOptions('google', { resolution: '1080P', duration: 4 }), /无效/);
  for (const spec of Object.values(VIDEO_PROVIDERS)) {
    validateVideoOptions(spec.id, spec.defaults);
    assert.equal(new URL(spec.keyUrl).protocol, 'https:');
  }
  const settings = new VideoSettings(path.join(root, 'settings.json'), crypto);
  settings.save({ provider: 'dashscope', model: 'wan2.7-i2v' });
  assert.equal(settings.publicConfig('dashscope').ratio, 'adaptive', 'Model overrides must choose compatible defaults');
  settings.save({ provider: 'minimax', apiKey: key, network: 'direct', duration: 6 });
  settings.save({ provider: 'google', apiKey: 'fixture-google', resolution: '1080P', duration: 8 });
  assert.equal(settings.publicState().provider, 'minimax', 'Saving another provider must not switch the default');
  settings.save({ provider: 'google', apiKey: '', setDefault: true });
  assert.equal(settings.credential('minimax'), key);
  assert.equal(settings.publicState().configs.minimax.duration, 6);
  assert.equal(settings.publicState().configs.minimax.network, 'direct');
  assert.equal(settings.credential('google'), 'fixture-google');
  assert.ok(!JSON.stringify(settings.publicState()).includes('fixture-'));
  assert.throws(() => settings.save({ provider: 'minimax', network: 'bad' }), /连接方式/);
  settings.save({ provider: 'minimax', clearKey: true });
  assert.equal(settings.publicState().provider, 'google', 'Clearing another provider must preserve default');
  assert.equal(settings.publicState().configs.minimax.hasApiKey, false);
  assert.equal(settings.publicState().configs.minimax.duration, 6);
  settings.save({ provider: 'minimax', apiKey: key, network: 'system', setDefault: true });

  const queries = [], providers = Object.fromEntries(['minimax', 'google'].map(provider => [provider, {
    create: async credential => { assert.equal(credential, settings.credential(provider)); return 'same-id'; },
    query: async (credential, id) => { queries.push([provider, credential, id]); return { status: 'running' }; },
  }]));
  const service = new VideoGeneration(settings, path.join(root, 'jobs.json'), { confirmGeneration: async () => true, providers, waitMs: 0 });
  await service.run('first-call', { action: 'generate', prompt: 'fixture' }, root);
  settings.save({ provider: 'google', setDefault: true });
  await service.run('resume', { action: 'status', task_id: 'same-id' }, root);
  assert.equal(queries.at(-1)[0], 'minimax', 'Resume must retain original provider after switching');
  await service.run('first-call', { action: 'generate', prompt: 'fixture' }, root);
  assert.equal(service.jobs().length, 1, 'Repeated call must reuse original job across provider switches');
  await service.run('second-call', { action: 'generate', prompt: 'fixture' }, root);
  await assert.rejects(service.run('ambiguous', { action: 'status', task_id: 'same-id' }, root), /多个平台/);
  await service.run('specific', { action: 'status', task_id: 'same-id', provider: 'google' }, root);
  assert.equal(queries.at(-1)[0], 'google');
  const models = await service.run('models', { action: 'models' }, root);
  assert.equal(models.providers.length, 2);
  assert.ok(!JSON.stringify(models).includes('fixture-'));
  const defaultModel = models.default_model;
  settings.save({ provider: 'google', model: 'veo-3.1-fast-generate-preview' });
  const reopened = new VideoSettings(settings.file, crypto);
  assert.equal(reopened.publicState().defaultModel, 'veo-3.1-fast-generate-preview', 'Saving the default provider must update its default model after restart');
  const routed = [];
  const routing = new VideoGeneration(reopened, path.join(root, 'routing.json'), { confirmGeneration: async () => true, waitMs: 0, providers: Object.fromEntries(['minimax', 'google'].map(id => [id, {
    create: async (_key, options) => { routed.push([id, options.model]); return `route-${routed.length}`; },
    query: async () => ({ status: 'running' }),
  }])) });
  await routing.run('default', { action: 'generate', prompt: 'fixture' }, root);
  assert.deepEqual(routed.at(-1), ['google', 'veo-3.1-fast-generate-preview']);
  await routing.run('explicit', { action: 'generate', provider: 'minimax', model: 'MiniMax-H3', prompt: 'fixture' }, root);
  assert.deepEqual(routed.at(-1), ['minimax', 'MiniMax-H3']);
  await routing.run('explicit-model', { action: 'generate', model: 'veo-3.1-fast-generate-preview', prompt: 'fixture' }, root);
  assert.deepEqual(routed.at(-1), ['google', 'veo-3.1-fast-generate-preview']);
  assert.equal(reopened.publicState().defaultModel, 'veo-3.1-fast-generate-preview');
  assert.throws(() => settings.save({ provider: 'vidu', setDefault: true }), /API Key/);
  assert.equal(settings.publicState().provider, 'google');
  const legacy = settings.read(); legacy.defaultModel = defaultModel;
  fs.writeFileSync(settings.file, JSON.stringify(legacy));
  const legacyModel = settings.publicConfig('google').model;
  assert.equal(settings.publicState().defaultModel, legacyModel, 'A stale legacy default must recover to the saved model');
  settings.save({ provider: 'minimax', duration: 5 });
  assert.equal(settings.publicState().defaultModel, legacyModel, 'Saving another provider must preserve the default');
  settings.save({ provider: 'google', model: defaultModel });
  assert.equal(settings.publicState().defaultModel, defaultModel);

  const empty = new VideoGeneration(settings, path.join(root, 'empty.json'), { confirmGeneration: async () => true, providers, waitMs: 0 });
  await assert.rejects(empty.run('no-image', { action: 'generate', provider: 'runway', model: 'gen4_turbo', prompt: 'fixture' }, root), /首帧/);

  let hop = 0;
  const downloads = new VideoGeneration(settings, path.join(root, 'downloads.json'), { confirmGeneration: async () => true, fetchImpl: async (url, init) => {
    if (hop++ === 0) {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/files/video:download');
      assert.equal(init.headers['x-goog-api-key'], 'fixture-google');
      return new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/video.mp4' } });
    }
    assert.equal(init.headers, undefined, 'Credentials must be stripped on a CDN redirect');
    return new Response(video);
  } });
  const downloaded = await downloads.download('https://generativelanguage.googleapis.com/v1beta/files/video:download', root, undefined,
    { downloadHeaders: { 'x-goog-api-key': 'fixture-google' }, downloadAuthOrigins: ['https://generativelanguage.googleapis.com'] });
  assert.deepEqual(fs.readFileSync(downloaded.file), video);
  downloads.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://cdn.example.test/leak' } });
  await assert.rejects(downloads.download('https://cdn.example.test/file', root), /无效/);

  const requests = [], xai = createVideoProviders({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    if (url.endsWith('/models')) return Response.json({ data: [] });
    if (init.method === 'POST') return Response.json({ request_id: 'fixture-xai' });
    return Response.json({ status: 'done', video: { url: 'https://vidgen.x.ai/file.mp4', respect_moderation: true } });
  } }).xai;
  await xai.test(key);
  assert.equal(requests[0].init.method, 'GET');
  await xai.create(key, { ...VIDEO_PROVIDERS.xai.defaults, prompt: 'fixture', firstFrame: 'data:image/png;base64,YQ==' });
  assert.deepEqual(JSON.parse(requests[1].init.body), { model: 'grok-imagine-video-1.5', prompt: 'fixture', duration: 5,
    resolution: '720p', aspect_ratio: '16:9', image: { url: 'data:image/png;base64,YQ==' } });
  assert.equal((await xai.query(key, 'fixture-xai')).status, 'succeeded');
  await assert.rejects(xai.query(key, '../leak'), /无效/);

  let attempts = 0;
  const broken = new VideoHTTP({ fetchImpl: async () => { attempts++; throw Object.assign(Error(key), { cause: { code: 'ECONNREFUSED' } }); } });
  await assert.rejects(broken.request('https://api.minimax.cn/v2/query/video_generation', { key }), error => error.message.includes('ECONNREFUSED') && !error.message.includes(key));
  assert.equal(attempts, 1, 'Proxy failure must never silently fall back to a different route');
  assert.throws(() => videoDispatcher('proxy', {}), /未配置全局代理/);
  assert.throws(() => videoDispatcher('proxy', { HTTPS_PROXY: 'invalid-private-proxy' }), error => !error.message.includes('invalid-private-proxy'));
  const denied = new VideoHTTP({ fetchImpl: async () => Response.json({ error: { message: key } }, { status: 403 }) });
  await assert.rejects(denied.request('https://api.x.ai/v1/models', { key }), error => error.status === 403 && !JSON.stringify(error.data).includes(key) && !error.message.includes(key));
  const nullError = new VideoHTTP({ fetchImpl: async () => Response.json(null, { status: 502 }) });
  await assert.rejects(nullError.request('https://api.x.ai/v1/models', { key }), error => error.status === 502);
  console.log('PASS ten video platforms, credential isolation, resume across providers, scoped download redirects, Grok payload and network errors');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('halo-video-platforms-'));
  fs.rmSync(root, { recursive: true, force: true });
}
