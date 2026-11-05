import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-image-progress-');
const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
const bridge = new PiBridge(new HaloStore(path.join(fixture.dir,'settings.json')),{}, {sessionDir:path.join(fixture.dir,'sessions')});
try {
  await bridge.start(fixture.dir);
  const session = bridge.session;
  session.emit({type:'agent_start'});
  session.emit({type:'tool_execution_start',toolCallId:'image',toolName:'image_generate'});
  const progress = {stage:'saving',startedAt:Date.now()-12000};
  session.emit({type:'tool_execution_update',toolCallId:'image',partialResult:{details:{imageProgress:progress}}});
  assert.deepEqual(bridge.snapshotView().imageProgress.image,progress);
  const copy=bridge.snapshotView().imageProgress;
  copy.image.stage='preparing';
  assert.equal(bridge.snapshotView().imageProgress.image.stage,'saving','View mutation must not change live progress');
  session.emit({type:'tool_execution_end',toolCallId:'image'});
  assert.deepEqual(bridge.snapshotView().imageProgress,{});
  session.emit({type:'tool_execution_start',toolCallId:'another',toolName:'image_generate'});
  session.emit({type:'tool_execution_update',toolCallId:'another',partialResult:{details:{imageProgress:progress}}});
  session.emit({type:'agent_settled'});
  assert.deepEqual(bridge.snapshotView().imageProgress,{},'Settled tasks must not restore an endless spinner');
  session.emit({type:'tool_execution_update',toolCallId:'another',partialResult:{details:{imageProgress:progress}}});
  assert.deepEqual(bridge.snapshotView().imageProgress,{},'Late progress must not resurrect a finished task');
  console.log('PASS image progress snapshots, independent views, completion, settlement and late updates');
} finally {await bridge.dispose();fixture.cleanup();}
