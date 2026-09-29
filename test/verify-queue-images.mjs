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
    };
    await bridge.steer('检查图片', { images:[image], names:['截图.png'] });
    assert.deepEqual(events.at(-1).steeringAttachments, [['截图.png']]);
    bridge.session.followUp = async (text, images) => {
      assert.equal(text, '后续任务'); assert.deepEqual(images, [image]);
      bridge.session.emit({ type:'queue_update', steering:['检查图片'], followUp:[text] });
    };
    await bridge.followUp('后续任务', { images:[image], names:['报告.png'] });
    assert.deepEqual(events.at(-1).followUpAttachments, [['报告.png']]);
    bridge.session.emit({ type:'queue_update', steering:[], followUp:['后续任务'] });
    assert.deepEqual(events.at(-1).steeringAttachments, []);
    assert.deepEqual(events.at(-1).followUpAttachments, [['报告.png']]);
  } finally { await bridge.dispose(); }
  console.log('PASS queue image payloads, labels, and dequeue alignment');
} finally { fixture.cleanup(); }
