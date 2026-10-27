import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-queue-remove-');
delete process.env.PI_HALO_PI_PATH;
try {
  const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
  const project = path.join(fixture.dir, 'project'); fs.mkdirSync(project);
  const bridge = new PiBridge(new HaloStore(path.join(fixture.dir, 'settings.json')), {},
    { sessionDir: path.join(fixture.dir, 'sessions') });
  try {
    await bridge.start(project);
    const session = bridge.session, events = [];
    bridge.onEvent((channel, payload) => { if (channel === 'pi:event' && payload.event.type === 'queue_update') events.push(payload.event); });
    const imageA = { type:'image', mimeType:'image/png', data:'AAAA' };
    const imageB = { type:'image', mimeType:'image/png', data:'BBBB' };
    await bridge.steer('方向', { images:[imageA], names:['方向.png'] });
    await bridge.followUp('相同', { images:[imageA], names:['第一张.png'] });
    await bridge.followUp('相同', { images:[imageB], names:['第二张.png'] });
    await bridge.followUp('第三条 @"C:/file.pdf"');
    const snapshot = bridge.snapshotView();
    assert.deepEqual(snapshot.queued.followUp, ['相同', '相同', '第三条 @"C:/file.pdf"']);
    assert.deepEqual(snapshot.queued.followUpAttachments, [['第一张.png'], ['第二张.png'], []]);
    const request = { sessionId:session.sessionId, kind:'followUp', index:1,
      queue:snapshot.queued.followUp, revision:snapshot.queued.revision };
    assert.throws(() => bridge.removeQueued({ ...request, sessionId:'other' }), /会话已切换/);
    assert.throws(() => bridge.removeQueued({ ...request, kind:'other' }), /无效/);
    const edited = bridge.removeQueued({ ...request, edit:true });
    assert.equal(edited.queuedDraft.text, '相同');
    assert.deepEqual(edited.queuedDraft.images, [{ name:'第二张.png', mediaType:'image/png', data:'BBBB' }]);
    assert.deepEqual(session.getFollowUpMessages(), ['相同', '第三条 @"C:/file.pdf"']);
    assert.deepEqual(session.getSteeringMessages(), ['方向']);
    assert.deepEqual(events.at(-1).followUpAttachments, [['第一张.png'], []]);
    assert.deepEqual(events.at(-1).steeringAttachments, [['方向.png']]);
    // A pending input hook may temporarily add attachment metadata before the
    // SDK emits its queue event; never shift the wrong image label in that gap.
    const followUp = session.followUp.bind(session);
    let accept;
    session.followUp = async (...args) => {
      await new Promise(resolve => { accept = resolve; });
      return followUp(...args);
    };
    const submitting = bridge.followUp('正在接收', { images:[imageB], names:['新接收.png'] });
    let updating = bridge.snapshotView().queued;
    assert.throws(() => bridge.removeQueued({ sessionId:session.sessionId, kind:'followUp', index:0,
      queue:updating.followUp, revision:updating.revision }), /队列正在更新/);
    accept(); await submitting;
    session.followUp = followUp;
    updating = bridge.snapshotView().queued;
    bridge.removeQueued({ sessionId:session.sessionId, kind:'followUp', index:2, queue:updating.followUp, revision:updating.revision });
    assert.deepEqual(events.at(-1).followUpAttachments, [['第一张.png'], []]);
    // Peek the follow-ups after temporarily hiding steering, preserving payloads.
    const steering = session.agent.peekQueuedMessages();
    session.agent.clearSteeringQueue();
    assert.deepEqual(session.agent.peekQueuedMessages()[0].content[1], imageA);
    steering.forEach(message => session.agent.steer(message));
    assert.throws(() => bridge.removeQueued(request), /队列已变化/);

    // Identical text does not make an old action valid after a dequeue/enqueue.
    const stale = bridge.snapshotView().queued;
    bridge.removeQueued({ sessionId:session.sessionId, kind:'followUp', index:0, queue:stale.followUp, revision:stale.revision });
    await bridge.followUp('相同', { images:[imageB], names:['新图.png'] });
    assert.throws(() => bridge.removeQueued({ sessionId:session.sessionId, kind:'followUp', index:0,
      queue:stale.followUp, revision:stale.revision }), /队列已变化/);
    let current = bridge.snapshotView().queued;
    const steeringDraft = bridge.removeQueued({ sessionId:session.sessionId, kind:'steering', index:0, queue:current.steering, revision:current.revision, edit:true });
    assert.equal(steeringDraft.queuedDraft.text, '方向');
    assert.equal(steeringDraft.queuedDraft.images[0].data, 'AAAA');
    current = bridge.snapshotView().queued;
    assert.deepEqual(current.steering, []);
    assert.deepEqual(current.followUp, ['第三条 @"C:/file.pdf"', '相同']);
    assert.deepEqual(current.followUpAttachments, [[], ['新图.png']]);
    assert.equal(session.agent.peekQueuedMessages()[0].content[0].text, '第三条 @"C:/file.pdf"');
    session.clearQueue();

    // An item removed while manual compaction is running must never start.
    let finish, started = 0;
    session.compact = () => new Promise(resolve => { finish = resolve; });
    session._startRun = async () => { started++; };
    const compacting = bridge.compact();
    await bridge.followUp('撤回后不执行');
    current = bridge.snapshotView().queued;
    bridge.removeQueued({ sessionId:session.sessionId, kind:'followUp', index:0, queue:current.followUp, revision:current.revision });
    finish({}); await compacting;
    assert.equal(started, 0);
    assert.equal(session.pendingMessageCount, 0);

    // Switching away and back restores the actual pending queue and revision.
    const background = bridge.compact();
    await bridge.followUp('后台消息', { images:[imageB], names:['后台.png'] });
    const originalFile = session.sessionFile;
    await bridge.newSession();
    assert.notEqual(bridge.session.sessionId, session.sessionId);
    await bridge.openSession(originalFile);
    current = bridge.snapshotView().queued;
    assert.deepEqual(current.followUp, ['后台消息']);
    assert.deepEqual(current.followUpAttachments, [['后台.png']]);
    bridge.removeQueued({ sessionId:session.sessionId, kind:'followUp', index:0, queue:current.followUp, revision:current.revision });
    assert.deepEqual(bridge.snapshotView().queued.followUp, []);
    finish({}); await background;
    console.log('PASS queue removal, duplicates, images, session changes, stale actions and compaction');
  } finally { await bridge.dispose(); }
} finally { fixture.cleanup(); }
