import { spawn } from 'node:child_process';

export function runGitAuth(args, { timeout = 15000, input = '', sensitive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_TRACE: '0', GIT_TRACE_CURL: '0', GCM_TRACE: '0',
        ...(sensitive ? { GCM_INTERACTIVE: 'never' } : {}) } });
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const timer = setTimeout(() => { child.kill(); reject(Error('GitHub 授权超时，请重试')); }, timeout);
    child.stdout.on('data', value => { output += value; if (output.length > 1024 * 1024) { child.kill(); reject(Error('GitHub 授权响应异常，请重试')); } });
    child.stderr.on('data', value => { error = (error + value).slice(-8000); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
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
  constructor({ run = runGitAuth, store } = {}) {
    this.run = run; this.store = store; this.busy = false; this.tokens = new Map();
    this.selectionRequest = 0; this.selectedAccount = ''; this.generation = 0; this.accountGenerations = new Map();
  }
  async status() {
    try {
      const text = await this.run(['credential-manager', 'github', 'list', '--no-ui']);
      const accounts = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(line));
      const saved = this.store?.data?.githubAccount || this.selectedAccount;
      const selectedAccount = accounts.includes(saved) ? saved : accounts[0] || '';
      return { available: true, accounts, selectedAccount, busy: this.busy };
    } catch (error) { return { available: false, accounts: [], selectedAccount: '', busy: this.busy, error: error.message }; }
  }
  async select(account) {
    const request = ++this.selectionRequest;
    const state = await this.status();
    if (!state.accounts.includes(account)) throw Error('未找到该授权账户，请先登录 GitHub');
    if (request !== this.selectionRequest) return this.status();
    this.selectedAccount = account;
    this.store?.set('githubAccount', account);
    return { ...state, selectedAccount: account };
  }
  invalidate(account) {
    if (account) { this.tokens.delete(account); this.accountGenerations.set(account, (this.accountGenerations.get(account) || 0) + 1); }
    else { this.tokens.clear(); this.generation++; }
  }
  // Never expose this method through IPC. Tokens remain in this main-process cache.
  async credential(account) {
    const state = await this.status();
    account ||= state.selectedAccount;
    if (!state.accounts.includes(account)) throw Error('未找到该授权账户，请先登录 GitHub');
    const cached = this.tokens.get(account);
    if (cached && cached.expires > Date.now()) return cached.token;
    const generation = this.generation, accountGeneration = this.accountGenerations.get(account) || 0;
    let response;
    try {
      response = await this.run(['credential-manager', 'get'], { sensitive: true,
        input: `protocol=https\nhost=github.com\nusername=${account}\n\n` });
    } catch { throw Error('GitHub 账户授权已过期，请重新登录'); }
    const fields = Object.fromEntries(response.split(/\r?\n/).filter(line => line.includes('=')).map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (fields.username?.toLowerCase() !== account.toLowerCase() || !fields.password || /[\r\n\0]/.test(fields.password)) {
      throw Error('GitHub 账户授权异常，请重新登录');
    }
    if (generation !== this.generation || accountGeneration !== (this.accountGenerations.get(account) || 0)) throw Error('GitHub 账户授权已更新，请重试');
    this.tokens.set(account, { token: fields.password, expires: Date.now() + 5 * 60 * 1000 });
    return fields.password;
  }
  async login() {
    if (this.busy) throw Error('GitHub 授权正在进行中');
    this.busy = true;
    try {
      await this.run(['credential-manager', 'github', 'login', '--browser'], { timeout: 5 * 60 * 1000 });
      // Limit the helper configuration to GitHub; keep other hosts' helpers untouched.
      const state = await this.status();
      if (!state.available || !state.accounts.length) throw Error('未检测到已授权的 GitHub 账户，请重试');
      this.invalidate();
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
      this.invalidate(account);
      return { ...await this.status(), busy: false };
    } finally { this.busy = false; }
  }
}
