import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';
import { startCompactionQueue } from '../src/main/compaction-queue.mjs';
import sharp from 'sharp';

const fixture = isolatePi('halo-compaction-queue-');
delete process.env.PI_HALO_PI_PATH;
try {
  const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
  const project = path.join(fixture.dir, 'project'); fs.mkdirSync(project);
  const bridge = new PiBridge(new HaloStore(path.join(fixture.dir, 'settings.json')), {},
    { sessionDir: path.join(fixture.dir, 'sessions') });
  try {
    await bridge.start(project);
    const session = bridge.session, image = { type: 'image', mimeType: 'image/png',
      data: (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer()).toString('base64') };
    const startRun = session._startRun;
    assert.equal(typeof session._startRun, 'function', 'installed SDK must support the adapter');
    const events = [], starts = [];
    bridge.onEvent((channel, payload) => { if (channel === 'pi:event') events.push(payload.event); });
    let finish;
    session.compact = () => new Promise(resolve => { finish = resolve; });
    session._startRun = async (trigger, onStarted) => {
      starts.push(trigger); onStarted();
    };
    const compacting = bridge.compact();
    assert.equal(bridge.publicState().isCompacting, true);
    await bridge.followUp('继续 @"C:/报告.pdf"', { images: [image], names: ['截图.png'] });
    await bridge.followUp('第二条');
    assert.equal(starts.length, 0, 'no run starts during compaction');
    assert.deepEqual(events.at(-1).followUp, ['继续 @"C:/报告.pdf"', '第二条']);
    assert.deepEqual(events.at(-1).followUpAttachments, [['截图.png'], []]);
    finish({ summary: 'summary' }); await compacting;
    assert.equal(bridge.publicState().isCompacting, false);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].prompt, '继续 @"C:/报告.pdf"');
    assert.deepEqual(starts[0].images, [image]);
    assert.deepEqual(session.getFollowUpMessages(), ['第二条']);
    assert.equal(session.agent.peekQueuedMessages()[0].content[0].text, '第二条');
    assert.equal(session.agent.followUpMode, 'one-at-a-time');
    await startCompactionQueue(session);
    assert.equal(starts[1].prompt, '第二条');
    assert.equal(session.pendingMessageCount, 0);

    // Direct prompt callers are queued too, and unfinished SDK input hooks are
    // included even when the compaction result arrives first.
    const followUp = session.followUp.bind(session);
    let accept;
    session.followUp = async (...args) => {
      await new Promise(resolve => { accept = resolve; });
      return followUp(...args);
    };
    const nextCompaction = bridge.compact();
    const submitting = bridge.prompt('延迟接收', { images: [image] });
    finish({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts.length, 2);
    accept(); await submitting; await nextCompaction;
    assert.equal(starts[2].prompt, '延迟接收');
    assert.deepEqual(starts[2].images, [image]);
    session.followUp = followUp;

    // Failed preparation retains both the text and images for a retry.
    await bridge.followUp('准备失败', { images: [image], names: ['保留.png'] });
    session._startRun = async () => { throw new Error('preparation failed'); };
    await assert.rejects(startCompactionQueue(session), /preparation failed/);
    assert.deepEqual(session.getFollowUpMessages(), ['准备失败']);
    assert.deepEqual(session.agent.peekQueuedMessages()[0].content[1], image);
    assert.deepEqual(events.at(-1).followUpAttachments, [['保留.png']]);
    session.clearQueue();

    // Run through the installed SDK's real preparation/settlement path, replacing
    // only the model request so this regression never needs accounts or network.
    session._startRun = startRun;
    const prompt = session.agent.prompt;
    let prepared;
    session.agent.prompt = async messages => { prepared = messages; };
    await bridge.followUp('真实核心启动', { images: [image] });
    await startCompactionQueue(session);
    assert.equal(prepared.at(-1).role, 'user');
    assert.equal(prepared.at(-1).content[0].text, '真实核心启动');
    assert.deepEqual(prepared.at(-1).content[1], image);
    assert.equal(session.isStreaming, false, 'real SDK settles the resumed run');
    session.agent.prompt = prompt;

    // Stopping compaction must not launch a fresh run behind the user's back.
    session._startRun = async () => { throw new Error('must not start'); };
    session.abort = async () => { finish({}); };
    const cancelled = bridge.compact();
    await bridge.followUp('保留待执行');
    await bridge.abort(); await cancelled;
    assert.deepEqual(session.getFollowUpMessages(), ['保留待执行']);
    session.clearQueue();

    // A focus change must not redirect the waiting message to the new session.
    session._startRun = async (trigger, onStarted) => { starts.push(trigger); onStarted(); };
    const background = bridge.compact();
    await bridge.followUp('原会话继续');
    await bridge.newSession();
    const focused = bridge.session;
    assert.notEqual(focused, session);
    finish({}); await background;
    assert.equal(starts.at(-1).prompt, '原会话继续');
    assert.equal(bridge.session, focused);
    assert.equal(focused.pendingMessageCount, 0);
    console.log('PASS compaction queue timing, FIFO, text/files/images, delayed acceptance, retry retention and abort');
  } finally { await bridge.dispose(); }
} finally { fixture.cleanup(); }
