import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {promoteQueuedMessage} from '../src/main/queue-promotion.mjs';
import {isolatePi} from './helpers/isolated-pi.mjs';
const fixture=isolatePi('halo-real-queue-');
delete process.env.PI_HALO_PI_PATH;
try {
 const {PiBridge,HaloStore}=await import('../src/main/pi-bridge.mjs');
 const project=path.join(fixture.dir,'project');fs.mkdirSync(project);
 const bridge=new PiBridge(new HaloStore(path.join(fixture.dir,'settings.json')),{}, {sessionDir:path.join(fixture.dir,'sessions')});
 try {
  await bridge.start(project);
  const events=[];
  bridge.onEvent((channel,payload)=>{if(channel==='pi:event'&&payload.event.type==='queue_update')events.push(payload.event);});
    assert.equal(bridge.session.followUpMode, 'one-at-a-time');
    const image = { type:'image', mimeType:'image/png', data:'AAAA' };
    await bridge.followUp('第一个任务', { images:[image], names:['第一张.png'] });
    await bridge.followUp('第二个任务', { images:[image], names:['第二张.png'] });
    await bridge.followUp('第三个任务');
    const queue = [...bridge.session.getFollowUpMessages()];
    await assert.rejects(bridge.promoteQueued({sessionId:'other',index:1,queue}), /会话已切换/);
    await assert.rejects(promoteQueuedMessage(bridge.session,1,['stale']), /队列已变化/);
    assert.deepEqual(bridge.session.getFollowUpMessages(),queue);
    await bridge.promoteQueued({sessionId:bridge.session.sessionId,index:1,queue});
    assert.deepEqual(bridge.session.getFollowUpMessages(),['第一个任务','第三个任务']);
    assert.deepEqual(bridge.session.getSteeringMessages(),['第二个任务']);
    assert.deepEqual(events.at(-1).steeringAttachments,[['第二张.png']]);
    assert.deepEqual(events.at(-1).followUpAttachments,[['第一张.png'],[]]);
    assert.deepEqual(bridge.session.agent.peekQueuedMessages()[0].content[1],image);
    bridge.session.agent.clearSteeringQueue();
    assert.equal(bridge.session.agent.peekQueuedMessages().length,1,'Follow-up mode consumes one message at a time');
    assert.deepEqual(bridge.session.agent.peekQueuedMessages()[0].content[1],image);
    bridge.session.clearQueue();

  console.log('PASS real Pi FIFO follow-ups, confirmed promotion, preserved images, stale queue/session rejection');
 }finally{await bridge.dispose();}
}finally{fixture.cleanup();}
