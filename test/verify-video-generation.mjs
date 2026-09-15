import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoSettings } from '../src/main/video-settings.mjs';
import { MiniMaxVideoProvider, validateVideoOptions } from '../src/main/video-providers.mjs';
import { VideoGeneration, videoTool } from '../src/main/video-generation.mjs';
import { videoResponse } from '../src/main/video-preview.mjs';
import { artifactPath } from '../src/renderer/js/artifacts.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-test-'));
const key = 'fixture-key-no-real-credentials';
const crypto = { seal: text => Buffer.from(text).toString('base64'), unseal: text => Buffer.from(text, 'base64').toString() };
try {
  const settings = new VideoSettings(path.join(root, 'settings.json'), crypto);
  assert.equal(settings.publicState().hasApiKey, false);
  assert.throws(() => settings.credential(), /API Key/);
  settings.save({ provider: 'minimax', apiKey: key });
  assert.equal(settings.credential(), key);
  assert.ok(!fs.readFileSync(settings.file, 'utf8').includes(key));
  assert.ok(!JSON.stringify(settings.publicState()).includes('encryptedApiKey'));
  settings.save({ ...settings.publicState(), duration: 7, apiKey: '' });
  assert.equal(settings.credential(), key);
  assert.equal(settings.publicState().duration, 7);
  assert.throws(() => settings.save({ provider: 'arbitrary', apiKey: key }));
  assert.throws(() => validateVideoOptions('minimax', { duration: 16 }));
  const denied = new VideoSettings(path.join(root, 'denied.json'), { ...crypto, seal: () => null });
  assert.throws(() => denied.save({ provider: 'minimax', apiKey: key }), /未保存/);
  assert.equal(fs.existsSync(denied.file), false);

  const requests = [], statuses = ['queued', 'running', 'succeeded'];
  const provider = new MiniMaxVideoProvider({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(new URL(url).origin, 'https://api.minimax.cn');
    if (init.method === 'POST') return Response.json({ task_id: 'task-123' });
    if (url.includes('?')) return Response.json({ items: [] });
    return Response.json({ task: { status: statuses.shift() || 'succeeded', content: { url: 'https://cdn.example.test/video.mp4' } } });
  } });
  await provider.test(key);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'GET', 'Connection test must not create paid videos');
  const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
  let failDownload = false;
  const service = new VideoGeneration(settings, path.join(root, 'jobs.json'), { confirmGeneration: async () => true, providers: { minimax: provider }, pollMs: 1,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers, undefined, 'Never send API credentials to CDN');
      return failDownload ? new Response('down', { status: 503 }) : new Response(video);
    } });
  const tool = videoTool(root, () => service), progress = [];
  const beforeApproval = requests.length;
  service.confirmGeneration = undefined;
  await assert.rejects(service.run('missing-approval', { action: 'generate', prompt: 'animate' }, root), /用户确认/);
  service.confirmGeneration = async () => false;
  assert.equal((await service.run('declined', { action: 'generate', prompt: 'animate' }, root)).status, 'cancelled');
  assert.equal(requests.length, beforeApproval, 'Unapproved generation must never contact provider');
  assert.equal(service.jobs().length, 0);
  service.confirmGeneration = async request => { assert.equal(request.model, 'MiniMax-H3'); return true; };
  const response = await tool.execute('call-1', { action: 'generate', prompt: '测试视频' }, undefined, result => progress.push(result));
  assert.ok(response.details.file.endsWith('.mp4'));
  assert.deepEqual(fs.readFileSync(response.details.file), video);
  assert.equal(progress.length, 5);
  assert.equal(progress[0].details.model, 'MiniMax-H3');
  assert.equal(progress[0].details.provider, 'minimax');
  assert.equal(response.details.usage, null);
  assert.match(progress[1].content[0].text, /MiniMax-H3/);
  const created = requests.find(request => request.init.method === 'POST');
  assert.deepEqual(JSON.parse(created.init.body), { model: 'MiniMax-H3', resolution: '768P', duration: 7, ratio: '16:9', content: [{ type: 'text', text: '测试视频' }] });
  await tool.execute('call-1', { action: 'generate', prompt: '测试视频' });
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 1, 'Repeated tool call ID must reuse task');
  assert.equal((await service.run('list', { action: 'list' }, path.join(root, 'other'))).tasks.length, 0);
  await assert.rejects(service.run('status', { action: 'status', task_id: 'task-123' }, path.join(root, 'other')), /没有此视频任务/);

  fs.unlinkSync(response.details.file); failDownload = true;
  const failed = await service.run('status', { action: 'status', task_id: 'task-123' }, root);
  assert.match(failed.error, /下载失败/);
  failDownload = false;
  const recovered = await service.run('status', { action: 'status', task_id: 'task-123' }, root);
  assert.ok(fs.existsSync(recovered.file));
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 1, 'Download retry must not regenerate');

  const range = videoResponse(new Request('https://local/video', { headers: { range: 'bytes=4-11' } }), recovered.file, video.length, 'video/mp4');
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'ftypisom');
  assert.equal(videoResponse(new Request('https://local/video', { headers: { range: 'bytes=999-' } }), recovered.file, video.length, 'video/mp4').status, 416);
  assert.equal(videoResponse(new Request('https://local/video', { method: 'HEAD' }), recovered.file, video.length, 'video/mp4').headers.get('content-length'), String(video.length));
  assert.ok(artifactPath(recovered.file, root).endsWith('.mp4'));
  await assert.rejects(service.download('http://local/file', root), /无效/);

  const controller = new AbortController();
  const pendingService = new VideoGeneration(settings, path.join(root, 'pending.json'), { confirmGeneration: async () => true, waitMs: 0, providers: { minimax: {
    create: async () => 'pending-1', query: async () => ({ status: 'running' }),
  } } });
  const pending = await pendingService.run('pending-call', { action: 'generate', prompt: 'pending' }, root);
  assert.equal(pending.task_id, 'pending-1');
  assert.equal(pending.status, 'running');
  pendingService.providers.minimax.query = async () => { controller.abort(); controller.signal.throwIfAborted(); };
  const stopped = await pendingService.run('resume', { action: 'status', task_id: 'pending-1' }, root, controller.signal);
  assert.match(stopped.error, /云端任务可能继续/);
  assert.equal(pendingService.jobs().length, 1);

  const errorProvider = new MiniMaxVideoProvider({ fetchImpl: async () => Response.json({ error: { message: `invalid ${key}` } }, { status: 401 }) });
  await assert.rejects(errorProvider.test(key), error => error.message.includes('401') && !error.message.includes(key));
  settings.save({ provider: 'minimax', clearKey: true });
  assert.equal(settings.publicState().hasApiKey, false);
  await assert.rejects(tool.execute('new', { action: 'generate', prompt: 'test' }), /API Key/);
  console.log('PASS video config secrecy, H3 V2 payloads, non-generating connection test, polling, task reuse, download recovery, project isolation and video ranges');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('halo-video-test-'));
  fs.rmSync(root, { recursive: true, force: true });
}
