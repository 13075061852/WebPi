import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-queue-images-');
try {
  const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
  const project = path.join(fixture.dir, 'project');
  fs.mkdirSync(project);
  const bridge = new PiBridge(new HaloStore(path.join(fixture.dir, 'settings.json')), {},
    { sessionDir:path.join(fixture.dir, 'sessions') });
  try {
    await bridge.start(project);
    const events = [];
    bridge.onEvent((channel, payload) => {
      if (channel === 'pi:event' && payload.event.type === 'queue_update') events.push(payload.event);
    });
    const image = { type:'image', mimeType:'image/png', data:'AAAA' };
    bridge.session.steer = async (text, images) => {
      assert.equal(text, '检查图片'); assert.deepEqual(images, [image]);
      bridge.session.emit({ type:'queue_update', steering:[text], followUp:[] });
      return 'queued';
    };
    await bridge.steer('检查图片', { images:[image], names:['截图.png'] });
    assert.deepEqual(events.at(-1).steeringAttachments, [['截图.png']]);
    bridge.session.followUp = async (text, images) => {
      assert.equal(text, '后续任务'); assert.deepEqual(images, [image]);
      bridge.session.emit({ type:'queue_update', steering:['检查图片'], followUp:[text] });
      return 'queued';
    };
    await bridge.followUp('后续任务', { images:[image], names:['报告.png'] });
    assert.deepEqual(events.at(-1).followUpAttachments, [['报告.png']]);
    bridge.session.emit({ type:'queue_update', steering:[], followUp:['后续任务'] });
    assert.deepEqual(events.at(-1).steeringAttachments, []);
    assert.deepEqual(events.at(-1).followUpAttachments, [['报告.png']]);

    // SDK 1.0.2 input handlers can consume input without emitting queue_update.
    // Exercise both queues while preserving an earlier item and concurrent calls.
    for (const [method, kind, attachmentKey] of [
      ['steer', 'steering', 'steeringAttachments'],
      ['followUp', 'followUp', 'followUpAttachments'],
    ]) {
      const emitQueue = (messages) => bridge.session.emit({
        type:'queue_update', steering:[], followUp:[], [kind]:messages,
      });
      const startExisting = async () => {
        bridge.session.emit({ type:'queue_update', steering:[], followUp:[] });
        bridge.session[method] = async (text, images) => {
          assert.equal(text, '已有任务'); assert.deepEqual(images, [image]);
          emitQueue([text]);
          return 'queued';
        };
        await bridge[method]('已有任务', { images:[image], names:['已有.png'] });
        assert.deepEqual(events.at(-1)[attachmentKey], [['已有.png']]);
      };

      await startExisting();
      const beforeHandled = events.length;
      bridge.session[method] = async (text, images) => {
        assert.equal(text, '扩展接管'); assert.deepEqual(images, [image]);
        return 'handled';
      };
      await bridge[method]('扩展接管', { images:[image], names:['接管.png'] });
      assert.equal(events.length, beforeHandled, `${method}: handled emits no queue update`);
      emitQueue(['已有任务']);
      assert.deepEqual(events.at(-1)[attachmentKey], [['已有.png']], `${method}: handled keeps prior attachments`);

      await startExisting();
      bridge.session[method] = async () => { throw new Error('input handler rejected'); };
      await assert.rejects(bridge[method]('拒绝任务', { names:['拒绝.pdf'] }), /input handler rejected/);
      emitQueue(['已有任务']);
      assert.deepEqual(events.at(-1)[attachmentKey], [['已有.png']], `${method}: rejected input is removed`);

      await startExisting();
      let resolveHandled, resolveQueued;
      const handledReady = new Promise((resolve) => { resolveHandled = resolve; });
      const queuedReady = new Promise((resolve) => { resolveQueued = resolve; });
      bridge.session[method] = async (text) => {
        if (text === '接管并发') {
          await handledReady;
          return 'handled';
        }
        assert.equal(text, '排队并发');
        await queuedReady;
        emitQueue(['已有任务', text]);
        return 'queued';
      };
      const handled = bridge[method]('接管并发', { names:['接管并发.pdf'] });
      const queued = bridge[method]('排队并发', { names:['排队并发.xlsx'] });
      resolveHandled();
      await handled;
      resolveQueued();
      await queued;
      assert.deepEqual(events.at(-1)[attachmentKey], [['已有.png'], ['排队并发.xlsx']], `${method}: cleanup removes only its own concurrent item`);
    }
  } finally { await bridge.dispose(); }
  console.log('PASS queue image payloads, labels, dequeue alignment, and SDK input dispositions');
} finally { fixture.cleanup(); }
