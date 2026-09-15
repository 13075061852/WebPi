import { spawn } from 'node:child_process';

export function runGitAuth(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('GitHub 授权超时，请重试')); }, timeout);
    child.stdout.on('data', value => { output = (output + value).slice(-8000); });
    child.stderr.on('data', value => { error = (error + value).slice(-8000); });
    child.on('error', () => { clearTimeout(timer); reject(Error('未找到 Git，请先配置 Git 环境')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(Error(/credential-manager.*not a git command|不是.*git.*命令/i.test(error)
        ? '此 Git 未安装 Credential Manager，请使用官方 Git 安装程序补装该组件'
        : 'GitHub 授权操作未完成，请检查网络、代理或浏览器授权结果'));
    });
  });
}

export class GitHubAuth {
  constructor({ run = runGitAuth } = {}) { this.run = run; this.busy = false; }
  async status() {
    try {
      const text = await this.run(['credential-manager', 'github', 'list', '--no-ui']);
      const accounts = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(line));
      return { available: true, accounts, busy: this.busy };
    } catch (error) { return { available: false, accounts: [], busy: this.busy, error: error.message }; }
  }
  async login() {
    if (this.busy) throw Error('GitHub 授权正在进行中');
    this.busy = true;
    try {
      await this.run(['credential-manager', 'github', 'login', '--browser'], { timeout: 5 * 60 * 1000 });
      // Limit the helper configuration to GitHub; keep other hosts' helpers untouched.
      const state = await this.status();
      if (!state.available || !state.accounts.length) throw Error('未检测到已授权的 GitHub 账户，请重试');
      await this.run(['config', '--global', '--replace-all', 'credential.https://github.com.helper', 'manager']);
      return { ...state, busy: false };
    } finally { this.busy = false; }
  }
  async logout(account) {
    if (this.busy) throw Error('GitHub 授权正在进行中');
    this.busy = true;
    try {
      const state = await this.status();
      if (!state.accounts.includes(account)) throw Error('未找到该授权账户');
      await this.run(['credential-manager', 'github', 'logout', account, '--no-ui']);
      return { ...await this.status(), busy: false };
    } finally { this.busy = false; }
  }
}
