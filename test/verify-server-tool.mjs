import { PiBridge, HaloStore } from '../src/main/pi-bridge.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'halo-ssh-tools-'));
const bridge = new PiBridge(new HaloStore(path.join(dir, 'settings.json')), {}, { sessionDir: path.join(dir, 'sessions') });
try {
  await bridge.start(dir);
  if (!bridge.session.getActiveToolNames().includes('ssh_exec')) throw Error('SSH tool not active');
  console.log('PASS ssh_exec registered in live pi runtime');
} finally { await bridge.runtime?.dispose(); }
process.exit(0);
