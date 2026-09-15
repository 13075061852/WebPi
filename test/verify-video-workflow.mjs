import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoSettings } from '../src/main/video-settings.mjs';
import { VideoGeneration } from '../src/main/video-generation.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-workflow-'));
const crypto = { seal: value => Buffer.from(value).toString('base64'), unseal: value => Buffer.from(value, 'base64').toString() };
try {
  const settings = new VideoSettings(path.join(root, 'settings.json'), crypto);
  settings.save({ provider: 'apimart', model: 'seedance-2.0-mini', resolution: '720P', duration: 5, apiKey: 'fixture-only', setDefault: true });
  // Reproduce the user's persisted mismatch from the previous implementation.
  const legacy = settings.read(); legacy.defaultModel = 'MiniMax-H3';
  fs.writeFileSync(settings.file, JSON.stringify(legacy));
  const calls = [], service = new VideoGeneration(settings, path.join(root, 'jobs.json'), { confirmGeneration: async () => true,
    waitMs: 0,
    providers: { apimart: {
      create: async (_key, options) => { calls.push(options); return `task-${calls.length}`; },
      query: async () => ({ status: 'running' }),
    } },
  });
  const models = await service.run('models', { action: 'models' }, root);
  const selected = models.providers.find(provider => provider.id === models.default_provider).selected;
  assert.equal(models.default_model, 'seedance-2.0-mini');
  assert.deepEqual(models.default_config, selected);
  assert.equal(models.default_config.model, models.default_model);
  const first = await service.run('first', { action: 'generate', prompt: 'fixture' }, root);
  assert.equal(first.model, 'seedance-2.0-mini');
  assert.deepEqual([calls[0].model, calls[0].resolution, calls[0].duration], ['seedance-2.0-mini', '720P', 5]);
  await service.run('case', { action: 'generate', prompt: 'fixture', resolution: '720p', duration: 8 }, root);
  assert.equal(calls[1].resolution, '720P');
  assert.equal(calls[1].model, 'seedance-2.0-mini');
  const beforeInvalid = calls.length;
  await assert.rejects(service.run('invalid', { action: 'generate', prompt: 'fixture', resolution: '2K' }, root), error => {
    assert.match(error.message, /seedance-2.0-mini.*分辨率无效.*480P、720P/);
    return true;
  });
  assert.equal(calls.length, beforeInvalid, 'Invalid parameters must not reach a paid endpoint');
  settings.save({ provider: 'apimart', model: 'seedance-2.5', resolution: '1080P', duration: 8 });
  settings.save({ provider: 'minimax', model: 'MiniMax-H3', duration: 4 });
  const reopened = new VideoSettings(settings.file, crypto);
  assert.equal(reopened.publicState().provider, 'apimart');
  assert.equal(reopened.publicState().defaultModel, 'seedance-2.5');
  await service.run('next', { action: 'generate', prompt: 'fixture' }, root);
  assert.deepEqual([calls.at(-1).model, calls.at(-1).resolution, calls.at(-1).duration], ['seedance-2.5', '1080P', 8]);
  const beforeResume = calls.length;
  const resumed = await service.run('resume', { action: 'status', task_id: first.task_id }, root);
  assert.equal(resumed.model, 'seedance-2.0-mini');
  assert.equal(calls.length, beforeResume);
  const duplicate = await service.run('first', { action: 'generate', prompt: 'fixture' }, root);
  assert.equal(duplicate.model, 'seedance-2.0-mini');
  assert.equal(calls.length, beforeResume);

  // A settings change while submitting must not retarget the already-started request.
  service.providers.apimart.create = async (_key, options) => {
    calls.push(options);
    settings.save({ provider: 'apimart', model: 'MiniMax-H3', resolution: '768P', duration: 4 });
    return 'snapshot-task';
  };
  const snapshot = await service.run('snapshot', { action: 'generate', prompt: 'fixture' }, root);
  assert.equal(snapshot.model, 'seedance-2.5');
  assert.equal(service.jobs().find(job => job.id === 'snapshot-task').resolution, '1080P');
  console.log('PASS video workflow: legacy mismatch recovery, coherent default parameters, model saves, validation before billing and immutable submitted tasks');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('halo-video-workflow-'));
  fs.rmSync(root, { recursive: true, force: true });
}
