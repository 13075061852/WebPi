import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoSettings } from '../src/main/video-settings.mjs';
import { VideoGeneration, videoTool } from '../src/main/video-generation.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-workflow-'));
const crypto = { seal: value => Buffer.from(value).toString('base64'), unseal: value => Buffer.from(value, 'base64').toString() };
try {
  const settings = new VideoSettings(path.join(root, 'settings.json'), crypto);
  settings.save({ provider: 'apimart', model: 'seedance-2.0-mini', resolution: '720P', duration: 5, apiKey: 'fixture-only', setDefault: true });
  // Reproduce the user's persisted mismatch from the previous implementation.
  const legacy = settings.read(); legacy.defaultModel = 'MiniMax-H3';
  fs.writeFileSync(settings.file, JSON.stringify(legacy));
  const calls = [], confirmations = [], service = new VideoGeneration(settings, path.join(root, 'jobs.json'), {
    confirmGeneration: async request => { confirmations.push(request); return true; },
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

  // The production tool must carry a user's multi-shot script verbatim through
  // confirmation and provider submission, including constraints and line breaks.
  const script = '【角色与场景】\r\n雨夜高空平台，银白外骨骼战士左盾右棍，黑色无人机甲在右侧；蓝白与琥珀指示灯不互换。\r\n' +
    '【四镜头分镜】\r\n0–3 秒：机甲冲锋，战士侧滑闪避；低机位中远景，积水飞溅。\r\n' +
    '3–7 秒：盾牌接住横击，战士后滑两道水痕，碰撞短暂减速。\r\n' +
    '7–11 秒：背部推进器启动，短棍击中肩部装甲，保持接触受力清楚。\r\n' +
    '11–15 秒：机甲撞上空货箱，战士落地制动；广角拉远，保留一秒静稳收尾。\r\n' +
    '【限制】正常速度为主，不换手，不加人物，不用满屏白光遮挡动作，无字幕。';
  const tool = videoTool(root, () => service);
  const detail = await tool.execute('detailed-script', { action: 'generate', prompt: script,
    model: 'MiniMax-H3', resolution: '768P', duration: 15, ratio: '16:9' });
  assert.equal(detail.details.model, 'MiniMax-H3');
  assert.equal(confirmations.at(-1).prompt, script, 'The confirmation must display the complete original multi-shot text');
  assert.equal(calls.at(-1).prompt, script, 'No backend rewrite, truncation or shot merging before submission');
  assert.equal(calls.at(-1).duration, 15);
  const concise = '雨夜，银甲战士左盾右棍格挡黑色机甲后反击；低机位侧拍，不换手，不加人物。';
  await tool.execute('concise-clear-script', { action: 'generate', prompt: concise });
  assert.equal(confirmations.at(-1).prompt, concise, 'Short but specific text must also reach confirmation unchanged');
  assert.equal(calls.at(-1).prompt, concise);

  // A settings change while submitting must not retarget the already-started request.
  service.providers.apimart.create = async (_key, options) => {
    calls.push(options);
    settings.save({ provider: 'apimart', model: 'MiniMax-H3', resolution: '768P', duration: 4 });
    return 'snapshot-task';
  };
  const snapshot = await service.run('snapshot', { action: 'generate', prompt: 'fixture' }, root);
  assert.equal(snapshot.model, 'seedance-2.5');
  assert.equal(service.jobs().find(job => job.id === 'snapshot-task').resolution, '1080P');
  console.log('PASS video workflow: coherent defaults, validation before billing, immutable tasks and verbatim detailed/concise scripts through real tool confirmation and submission');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('halo-video-workflow-'));
  fs.rmSync(root, { recursive: true, force: true });
}
