import assert from 'node:assert/strict';
import { PiBridge, HaloStore } from '../src/main/pi-bridge.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-office-runtime-'));
const bridge=new PiBridge(new HaloStore(path.join(dir,'settings.json')),{}, {sessionDir:path.join(dir,'sessions')});
try {
  await bridge.start(dir);
  assert.ok(bridge.session.getActiveToolNames().includes('office_document'));
  const resources=bridge.listResources();
  for(const name of ['halo-word','halo-excel','halo-powerpoint','halo-pdf'])assert.ok(resources.skills.some(s=>s.name===name),'Missing skill '+name);
  console.log('PASS all four built-in Office skills and office_document available in real SDK runtime');
} finally {await bridge.runtime?.dispose();}
process.exit(0);
