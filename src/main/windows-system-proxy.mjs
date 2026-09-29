import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function windowsProxyState(config) {
  return config.mode === 'proxy'
    ? { flags:3, server:`127.0.0.1:${config.port}`, bypass:'localhost;127.0.0.1;[::1]', script:'' }
    : { flags:1, server:'', bypass:'', script:'' };
}
export class WindowsSystemProxy {
  constructor({ run, platform = process.platform } = {}) { this.runner = run; this.platform = platform; }
  async run(action, state) {
    if (this.runner) return this.runner({action, state});
    if (this.platform !== 'win32') throw Error('系统代理切换目前仅支持 Windows');
    return new Promise((resolve, reject) => {
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./windows-proxy.ps1', import.meta.url)).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')], {windowsHide:true, stdio:['pipe','pipe','pipe']});
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(Error('Windows 系统代理操作超时')); }, 20000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16000); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdin.on('error', () => {});
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(Error('无法修改 Windows 系统代理：' + (stderr.trim() || '请检查系统策略或权限')));
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
        catch { reject(Error('无法读取 Windows 系统代理状态')); }
      });
      child.stdin.end(JSON.stringify({ action, state }));
    });
  }
  read() { return this.run('read'); }
  async restore(state) {
    const actual = await this.run('write', state);
    if (actual.flags !== state.flags || actual.server !== state.server || actual.script !== state.script || actual.bypass !== state.bypass) {
      throw Error('Windows 系统代理未按预期生效，可能被系统策略或其他代理软件覆盖');
    }
    return actual;
  }
  apply(config) { return this.restore(windowsProxyState(config)); }
}
