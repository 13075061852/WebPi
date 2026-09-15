import { spawn } from 'node:child_process';
import { resolvePiCli } from './pi-runtime.mjs';

// Electron already contains Node. Run our bundled Pi CLI with that runtime,
// without depending on a global pi.cmd, a system Node install, or a shell.
export function spawnPi(args, {
  cwd,
  timeout = 180000,
  cliPath,
  executable = process.execPath,
  env = process.env,
} = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, [cliPath || resolvePiCli(), ...args], {
        cwd,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
      return;
    }
    let out = '', err = '', settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: '超时（3 分钟）', output: out.slice(-1200) });
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { out = (out + data).slice(-16000); });
    child.stderr.on('data', data => { err = (err + data).slice(-16000); });
    child.on('error', error => finish({ ok: false, error: String(error?.message || error) }));
    child.on('close', code => finish({ ok: code === 0, code, output: (out + '\n' + err).trim().slice(-1600) }));
  });
}
