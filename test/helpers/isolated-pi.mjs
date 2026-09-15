import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isolatePi(prefix = 'halo-pi-regression-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const originalHome = os.homedir;
  const originalTmpdir = os.tmpdir;
  const originalEnv = Object.fromEntries(['PI_HALO_PI_PATH', 'PI_CODING_AGENT_DIR'].map(key => [key, process.env[key]]));
  os.homedir = () => dir;
  os.tmpdir = () => dir;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, '.pi', 'agent');
  process.env.PI_HALO_PI_PATH = fileURLToPath(new URL('../fixtures/pi-sdk.js', import.meta.url));
  fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  return {
    dir,
    cleanup() {
      os.homedir = originalHome;
      os.tmpdir = originalTmpdir;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
