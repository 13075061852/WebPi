import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export function wranglerPath() {
  const entry = createRequire(import.meta.url).resolve('wrangler');
  const unpacked = entry.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return fs.existsSync(unpacked) ? unpacked : entry;
}
export function runWrangler(args, { cwd, env = {}, signal, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const launcher = fileURLToPath(new URL('./cloudflare-cli.cjs', import.meta.url));
    const child = spawn(process.execPath, ['--require', launcher, wranglerPath(), ...args], {
      cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WRANGLER_SEND_METRICS: 'false', ...env },
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal,
    });
    let output = '', errors = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', value => { output = (output + value).slice(-64000); });
    child.stderr.on('data', value => { errors = (errors + value).slice(-8000); });
    child.on('error', () => { clearTimeout(timer); reject(Error('Cloudflare 命令无法启动或已取消')); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output, errors });
    });
  });
}
export class CloudflareService {
  constructor({ run = runWrangler, cwd } = {}) { this.run = run; this.cwd = cwd; this.busy = false; this.deploying = new Set(); }
  async status() {
    const result = await this.run(['whoami', '--json'], { cwd: this.cwd });
    try {
      const data = JSON.parse(result.output);
      return { authorized: !!data.loggedIn, email: data.email || '',
        accounts: (data.accounts || []).map(account => ({ id: account.id, name: account.name })) };
    } catch { throw Error('无法查询 Cloudflare 授权，请检查网络和代理'); }
  }
  async auth(action) {
    if (this.busy) throw Error('Cloudflare 授权正在进行中');
    if (!['login', 'logout'].includes(action)) throw Error('无效的授权操作');
    this.busy = true;
    try {
      const result = await this.run([action], { cwd: this.cwd, timeout: 300000 });
      if (!result.ok) throw Error('Cloudflare 授权未完成，请检查浏览器和网络后重试');
      return await this.status();
    } finally { this.busy = false; }
  }
  async deploy(cwd, input, signal) {
    if (this.deploying.has(cwd)) throw Error('此项目正在部署');
    const config = fs.realpathSync(path.resolve(cwd, input.config || 'wrangler.jsonc'));
    const root = fs.realpathSync(cwd), relative = path.relative(root, config);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('部署配置必须位于当前项目内');
    if (!/\.(jsonc?|toml)$/i.test(config)) throw Error('请提供 Wrangler 配置文件');
    if (input.account_id && !/^[a-f0-9]{32}$/i.test(input.account_id)) throw Error('Cloudflare 账户 ID 无效');
    this.deploying.add(cwd);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cloudflare-'));
    const outputFile = path.join(dir, 'deployment.jsonl');
    try {
      const state = await this.status();
      if (!state.authorized) throw Error('请先在设置 → 环境配置中授权 Cloudflare');
      const account = input.account_id || (state.accounts.length === 1 ? state.accounts[0].id : null);
      if (!account || !state.accounts.some(item => item.id === account)) throw Error('请选择已授权的 Cloudflare 账户 ID；可用 status 查询');
      const result = await this.run(['deploy', '--config', config], { cwd, signal, timeout: 600000,
        env: { CLOUDFLARE_ACCOUNT_ID: account, CI: 'true', WRANGLER_OUTPUT_FILE_PATH: outputFile } });
      if (!result.ok) throw Error('Cloudflare 部署失败或已取消。请检查项目构建、Wrangler 配置及账户权限，勿报告部署成功。');
      const records = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
      const deployment = records.findLast(item => item.type === 'deploy');
      const urls = [...new Set((deployment?.targets || []).filter(target => typeof target === 'string' && /^https:\/\//.test(target)))];
      return { deployed: true, worker: deployment?.worker_name || null, urls,
        message: urls.length ? '部署成功。界面会在回复底部统一显示含完整网址的交付卡片，支持内置浏览器预览、复制和外部打开。正文只简短说明部署结果，不要重复输出网址或 Markdown 链接。' : '部署成功，但未返回公共访问地址，请检查 workers_dev 或自定义域名配置，不要编造链接' };
    } finally {
      this.deploying.delete(cwd);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
      fs.rmdirSync(dir);
    }
  }
}
export function cloudflareTool(cwd, getService) {
  return { name: 'cloudflare_deploy', label: 'Cloudflare 部署',
    description: '仅在用户要求部署或更新线上网站时使用。status 查看授权账户；deploy 部署当前项目并返回实际网站链接。先完成构建和必要检查，准备项目内 wrangler.jsonc（静态网站 assets.directory 只指向公开构建产物、workers_dev:true；有后端则按 Workers 兼容性配置），不得上传密钥、.env 或整个含私密文件的工作区。不需要另外安装 Wrangler。多账户时明确选择 account_id。失败不能声称成功，成功后由底部交付卡片统一展示 urls，正文不要重复输出部署网址或链接。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'deploy'] }, config: { type: 'string' }, account_id: { type: 'string' } }, required: ['action'] },
    execute: async (_id, args, signal, onUpdate) => {
      const service = getService(); if (!service) throw Error('Cloudflare 服务未就绪');
      if (!['status', 'deploy'].includes(args.action)) throw Error('无效的部署操作');
      onUpdate?.({ content: [{ type: 'text', text: args.action === 'deploy' ? '正在部署至 Cloudflare…' : '正在查询授权…' }] });
      const result = args.action === 'status' ? await service.status() : await service.deploy(cwd, args, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } };
}
