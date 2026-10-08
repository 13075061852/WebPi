import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ERRORS = {
  cancelled: '已取消管理员授权，未完成配置，可重新点击一键配置。',
  'not-installed': '此电脑未安装 Microsoft Store。',
  'verify-failed': '配置未生效，请检查 Windows 安全策略后重试。',
  'repair-failed': '无法配置商店的本地代理访问权限，请检查管理员授权或系统策略。',
  'read-failed': '无法读取商店的本地代理访问状态，请稍后重试。',
  'tool-unavailable': '此 Windows 系统缺少网络隔离配置工具。',
};

export function runStoreProxy(action, { spawnProcess = spawn, env = process.env, timeout = action === 'repair' ? 120000 : 20000 } = {}) {
  if (!['status', 'repair'].includes(action)) return Promise.reject(Error('不支持的商店配置操作'));
  return new Promise((resolve, reject) => {
    const executable = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = fileURLToPath(new URL('./store-proxy.ps1', import.meta.url)).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    let child, timer, settled = false, stdout = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    try {
      child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { finish(Error('无法启动 Windows 商店配置工具')); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      if (stdout.length + chunk.length > 65536) {
        finish(Error('商店配置工具返回内容异常，请重新检测')); child.kill(); return;
      }
      stdout += chunk;
    });
    // The helper returns bounded, structured diagnostics on stdout. Do not expose
    // arbitrary localized PowerShell text, user paths or elevation stderr to UI.
    child.stderr.resume();
    child.on('error', () => finish(Error('无法启动 Windows 商店配置工具')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (settled) return;
      let value;
      try { value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); }
      catch { finish(Error('无法读取 Windows 商店配置结果')); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { finish(Error('无法读取 Windows 商店配置结果')); return; }
      if (value.error) { finish(Error(ERRORS[value.error] || 'Windows 商店配置失败，请重新检测')); return; }
      if (code !== 0 || value.supported !== true || typeof value.installed !== 'boolean' || typeof value.enabled !== 'boolean' || (!value.installed && value.enabled)) {
        finish(Error('无法验证 Windows 商店配置结果')); return;
      }
      finish(null, { supported: true, installed: value.installed, enabled: value.enabled });
    });
    timer = setTimeout(() => {
      finish(Error(action === 'repair'
        ? '等待商店配置超时。如管理员授权窗口仍在，请先处理，然后重新打开代理配置页确认状态。'
        : '读取商店配置超时，请稍后重试。'));
      // A UAC-launched process may still finish later. Do not report cancellation
      // or attempt to undo settings; the next action always reads actual OS state.
      child.kill();
    }, timeout);
    child.stdin.end(JSON.stringify({ action }));
  });
}

export class StoreProxy {
  constructor({ run = runStoreProxy, platform = process.platform } = {}) {
    this.run = run; this.platform = platform; this.job = null;
  }
  async status() {
    if (this.platform !== 'win32') return { supported: false, installed: false, enabled: false };
    return this.job || this.run('status');
  }
  repair() {
    if (this.platform !== 'win32') return Promise.reject(Error('商店代理配置仅支持 Windows'));
    if (this.job) return this.job;
    this.job = (async () => {
      const before = await this.run('status');
      if (!before.installed) throw Error(ERRORS['not-installed']);
      if (before.enabled) return before;
      await this.run('repair');
      // Read from the original user context after elevation; a successful exit
      // code alone is not proof that the Store exemption was actually added.
      const after = await this.run('status');
      if (!after.installed || !after.enabled) throw Error(ERRORS['verify-failed']);
      return after;
    })().finally(() => { this.job = null; });
    return this.job;
  }
}
