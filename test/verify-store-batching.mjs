import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';
const fixture = isolatePi('halo-store-batching-');
const { HaloStore } = await import('../src/main/pi-bridge.mjs');
const file = path.join(fixture.dir, 'store.json');
const store = new HaloStore(file);
const rename = fs.renameSync;
let writes = 0;
try {
  fs.renameSync = (...args) => { writes++; return rename(...args); };
  for (let i = 0; i < 100; i++) store.set('telemetry', i, { defer: true });
  assert.equal(writes, 0); assert.equal(store.data.telemetry, 99);
  assert.equal(store.flush(), true); assert.equal(writes, 1);
  assert.equal(new HaloStore(file).data.telemetry, 99);
  store.set('telemetry', 100, { defer: true });
  const id = store.getDeviceId(); // Critical identity forces durable write.
  assert.equal(new HaloStore(file).getDeviceId(), id); assert.equal(writes, 2);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(writes, 2, 'Cancelled batch must not repeat an immediate save');
  store.set('telemetry', 101, { defer: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(new HaloStore(file).data.telemetry, 101); assert.equal(writes, 3);
  console.log('PASS 100 telemetry updates coalesced to one atomic write; critical identity, flush and timed persistence retained');
} finally { fs.renameSync = rename; store.flush(); fixture.cleanup(); }
