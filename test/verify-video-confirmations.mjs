import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoConfirmations } from '../src/main/video-confirmations.mjs';
import { VideoGeneration } from '../src/main/video-generation.mjs';
import { VideoSettings } from '../src/main/video-settings.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-confirm-'));
try {
  const settings = new VideoSettings(path.join(root, 'settings.json'), { seal: s => Buffer.from(s).toString('base64'), unseal: s => Buffer.from(s, 'base64').toString() });
  settings.save({ provider: 'apimart', apiKey: 'fixture', enabled: true, setDefault: true });
  const broker = new VideoConfirmations(), submitted = [];
  let request;
  const service = new VideoGeneration(settings, path.join(root, 'jobs.json'), {
    waitMs: 0, confirmGeneration: (r, signal, publish) => broker.ask(r, signal, c => { request = c; publish(c); }),
    providers: { apimart: { create: async (_key, options) => { submitted.push(options); return 'test-task'; }, query: async () => ({ status: 'running' }) } },
  });
  const updates = [];
  const run = service.run('test', { action: 'generate', prompt: 'fixture' }, root, undefined, update => updates.push(update));
  while (!request) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(submitted.length, 0);
  assert.equal(updates.at(-1).details.confirmation.id, request.id);
  assert.equal(broker.list()[0].callId, 'test', 'Pending confirmation can be restored after switching sessions');
  assert.throws(() => broker.respond({ id: request.id, approved: true, options: { model: 'sora-2', duration: 5, resolution: '720P', ratio: '16:9' } }), /时长/);
  assert.equal(broker.pending.size, 1, 'Invalid selections stay editable');
  broker.respond({ id: request.id, approved: true, options: { model: 'sora-2', duration: 8, resolution: '720P', ratio: '9:16' } });
  await run;
  assert.deepEqual(broker.list(), []);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].model, 'sora-2'); assert.equal(submitted[0].duration, 8); assert.equal(submitted[0].ratio, '9:16');
  assert.equal(service.jobs()[0].model, 'sora-2');
  assert.throws(() => broker.respond({ id: request.id, approved: true }), /已结束/);
  const controller = new AbortController();
  const waiting = broker.ask({}, controller.signal, () => {});
  controller.abort(); assert.equal(await waiting, false); assert.equal(broker.pending.size, 0);
  const closing = broker.ask({}, undefined, () => {}); broker.dispose(); assert.equal(await closing, false);
  console.log('PASS inline video confirmation: edited parameters, validation, duplicate rejection, cancellation');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
