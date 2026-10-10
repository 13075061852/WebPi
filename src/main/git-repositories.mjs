import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ACCOUNT = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const REPO = /^[a-zA-Z0-9_.-]{1,100}$/;
const API = 'https://api.github.com';

export function githubRepositoryName(value) {
  if (typeof value !== 'string') throw Error('请选择有效的 GitHub 仓库');
  const [owner, name, extra] = value.split('/');
  if (extra !== undefined || !ACCOUNT.test(owner || '') || !REPO.test(name || '') || /^\.+$/.test(name)) {
    throw Error('请选择有效的 GitHub 仓库');
  }
  return `${owner}/${name}`;
}

export function githubRepositoryURL(fullName) { return `https://github.com/${githubRepositoryName(fullName)}.git`; }

function remoteName(value) {
  let text = String(value || '').trim();
  const ssh = /^git@github\.com:([^\s]+)$/i.exec(text);
  if (ssh) text = `https://github.com/${ssh[1]}`;
  try {
    const url = new URL(text);
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.port || url.password || url.search || url.hash) return '';
    if (url.username && url.username !== 'git' && !ACCOUNT.test(url.username)) return '';
    return githubRepositoryName(url.pathname.replace(/^\//, '').replace(/\.git$/, '').replace(/\/$/, ''));
  } catch { return ''; }
}

function gitFailure(stderr = '', code) {
  let message = 'Git 操作失败，请检查网络、代理和仓库权限后重试';
  if (/not a git repository/i.test(stderr)) message = '当前目录不是 Git 仓库，请先关联或克隆';
  else if (/dubious ownership/i.test(stderr)) message = '该目录所有者与当前用户不同，请检查目录权限后重试';
  else if (/authentication failed|could not read Username|terminal prompts disabled|invalid username|credentials/i.test(stderr)) message = 'GitHub 账户授权已过期或权限不足，请重新登录';
  else if (/non-fast-forward|fetch first|rejected|Not possible to fast-forward/i.test(stderr)) message = '远程仓库已有新提交或分支已分叉，请先同步；不会强制覆盖远程内容';
  else if (/unable to access|Could not resolve|Failed to connect|Connection timed out/i.test(stderr)) message = '无法连接 GitHub，请检查网络和代理设置';
  else if (/Author identity unknown|unable to auto-detect email/i.test(stderr)) message = '缺少提交者信息，请设置仓库的 Git 用户名和邮箱';
  else if (/nothing to commit|no changes added/i.test(stderr)) message = '所选文件没有可提交的更改';
  const error = Error(message); error.gitCode = code;
  error.gitMissing = /not a git repository|Needed a single revision|unknown revision or path|ambiguous argument|no upstream configured|does not point to a branch|ref HEAD is not a symbolic ref/i.test(stderr);
  return error;
}

export function runRepositoryGit(args, { cwd, input = '', timeout = 120000, env: extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0',
      GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_CURL_VERBOSE: '0', GCM_TRACE: '0' };
    // A caller's terminal Git environment must not redirect this operation to another worktree or index.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete env[key];
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
    const child = spawn('git', args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(Error('Git 操作超时，请检查网络后重试')); }, timeout);
    child.stdout.on('data', value => {
      stdout += value;
      if (stdout.length > 8 * 1024 * 1024) { child.kill(); finish(Error('仓库响应过大，请先通过 .gitignore 排除依赖和生成目录后重试')); }
    });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-64000); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', () => finish(Error('未找到 Git，请先在环境配置中安装 Git')));
    child.on('close', code => finish(code === 0 ? null : gitFailure(stderr, code), stdout));
  });
}

function parseStatus(text) {
  const records = text.split('\0'), files = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.length < 4) continue;
    const status = row.slice(0, 2), file = { path: row.slice(3), status, staged: status[0] !== ' ' && status[0] !== '?' };
    if (/[RC]/.test(status) && records[i + 1]) { const original = records[++i]; if (/R/.test(status)) file.oldPath = original; }
    files.push(file);
  }
  return files;
}

function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }

export class GitRepositories {
  constructor({ auth, store, fetchImpl = globalThis.fetch, runGit = runRepositoryGit } = {}) {
    this.auth = auth; this.store = store; this.fetchImpl = fetchImpl; this.runGit = runGit;
    this.cache = new Map(); this.users = new Map(); this.pending = new Map(); this.operations = new Set();
    this.generation = 0; this.accountGenerations = new Map();
  }
  invalidate(account) {
    if (account) { this.cache.delete(account); this.users.delete(account); this.accountGenerations.set(account, (this.accountGenerations.get(account) || 0) + 1); }
    else { this.cache.clear(); this.users.clear(); this.generation++; }
  }
  async account(value) {
    const state = await this.auth.status();
    const account = value || state.selectedAccount || state.accounts[0];
    if (!ACCOUNT.test(account || '') || !state.accounts.includes(account)) throw Error('请先登录并选择 GitHub 账户');
    return account;
  }
  async request(account, route, { method = 'GET', body } = {}) {
    if (!route.startsWith('/') || route.startsWith('//')) throw Error('GitHub 请求地址无效');
    const token = await this.auth.credential(account);
    let response;
    try {
      response = await this.fetchImpl(`${API}${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Pi-Halo', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw Error('无法连接 GitHub，请检查网络和代理设置后重试'); }
    if (!response.ok) {
      if (response.status === 401) { this.auth.invalidate?.(account); this.invalidate(account); throw Error('GitHub 账户授权已过期，请重新登录'); }
      if (response.status === 403 || response.status === 429) throw Error('GitHub 请求受到限制或仓库权限不足，请检查授权后重试');
      if (response.status === 404) throw Error('仓库不存在或当前账户无权访问');
      if (response.status === 422) throw Error('仓库名称已存在或参数无效，请修改后重试');
      throw Error(`GitHub 请求失败（${response.status}），请稍后重试`);
    }
    let data;
    try { data = await response.json(); } catch { throw Error('GitHub 响应异常，请稍后重试'); }
    return { data, headers: response.headers };
  }
  mappings() { return this.store?.data?.githubRepositories || {}; }
  mappingKey(account, fullName) { return `${account.toLowerCase()}:${fullName.toLowerCase()}`; }
  localPath(account, fullName) { return this.mappings()[this.mappingKey(account, fullName)]?.localPath || ''; }
  savePath(account, fullName, localPath, repository = {}) {
    const key = this.mappingKey(account, fullName), previous = this.mappings()[key] || {};
    const metadata = {};
    for (const field of ['id', 'name', 'description', 'private', 'url', 'defaultBranch', 'canPush', 'archived']) {
      if (repository[field] !== undefined) metadata[field] = repository[field];
    }
    this.store?.set('githubRepositories', { ...this.mappings(), [key]: { ...previous, ...metadata, account, fullName, localPath } });
  }
  async local({ account = '' } = {}) {
    if (typeof account !== 'string' || (account && !ACCOUNT.test(account))) throw Error('请选择有效的 GitHub 账户');
    const repositories = (await Promise.all(Object.entries(this.mappings()).map(async ([key, saved]) => {
      if (!saved || typeof saved !== 'object') return null;
      const separator = key.indexOf(':'), owner = saved.account || key.slice(0, separator);
      if (typeof owner !== 'string' || !ACCOUNT.test(owner) || (account && owner.toLowerCase() !== account.toLowerCase())) return null;
      let fullName;
      try { fullName = githubRepositoryName(saved.fullName || key.slice(separator + 1)); } catch { return null; }
      if (typeof saved.localPath !== 'string' || !path.isAbsolute(saved.localPath)) return null;
      let localPath;
      try {
        localPath = await fs.promises.realpath(saved.localPath);
        if (!(await fs.promises.stat(localPath)).isDirectory()) return null;
      } catch { return null; }
      const cached = this.cache.get(owner)?.repositories.find(row => row.fullName.toLowerCase() === fullName.toLowerCase());
      const metadata = { ...cached, ...saved };
      return { account: owner, id: metadata.id, name: fullName.split('/')[1], fullName, localPath,
        description: String(metadata.description || ''), private: metadata.private !== false, url: `https://github.com/${fullName}`,
        defaultBranch: String(metadata.defaultBranch || 'main'), canPush: typeof metadata.canPush === 'boolean' ? metadata.canPush : undefined, archived: metadata.archived === true };
    }))).filter(Boolean);
    return { account, repositories, total: repositories.length };
  }
  row(data, account) {
    const fullName = githubRepositoryName(data.full_name);
    return { id: data.id, name: fullName.split('/')[1], fullName, description: String(data.description || ''),
      private: !!data.private, url: `https://github.com/${fullName}`, defaultBranch: String(data.default_branch || 'main'),
      canPush: data.permissions?.push === true || (data.permissions?.push === undefined && data.owner?.login?.toLowerCase() === account.toLowerCase()),
      archived: !!data.archived, localPath: this.localPath(account, fullName) };
  }
  async list({ account: value, force = false } = {}) {
    const account = await this.account(value), cached = this.cache.get(account);
    if (!force && cached && Date.now() - cached.time < 60000) return this.listResult(account, cached.repositories);
    if (this.pending.has(account)) return this.pending.get(account);
    const generation = this.generation, accountGeneration = this.accountGenerations.get(account) || 0;
    const work = (async () => {
      const repositories = [], seen = new Set();
      let page = 1;
      while (page <= 10000) {
        const { data, headers } = await this.request(account, `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=100&page=${page}`);
        if (!Array.isArray(data)) throw Error('GitHub 仓库列表响应异常');
        for (const value of data) { const row = this.row(value, account); if (!seen.has(row.fullName.toLowerCase())) { seen.add(row.fullName.toLowerCase()); repositories.push(row); } }
        const next = headers?.get?.('link')?.includes('rel="next"');
        if (!next && data.length < 100) break;
        if (!data.length) break;
        page++;
      }
      if (page > 10000) throw Error('仓库数量过多，请稍后重试');
      if (generation !== this.generation || accountGeneration !== (this.accountGenerations.get(account) || 0)) throw Error('GitHub 账户授权已更新，请刷新仓库列表');
      this.cache.set(account, { time: Date.now(), repositories });
      return this.listResult(account, repositories);
    })();
    this.pending.set(account, work);
    try { return await work; } finally { this.pending.delete(account); }
  }
  listResult(account, repositories) { return { account, repositories: repositories.map(row => ({ ...row, localPath: this.localPath(account, row.fullName) })), total: repositories.length }; }
  async repository(account, fullName) {
    fullName = githubRepositoryName(fullName);
    const cached = this.cache.get(account)?.repositories.find(row => row.fullName.toLowerCase() === fullName.toLowerCase());
    if (cached) return { ...cached, localPath: this.localPath(account, cached.fullName) };
    return this.row((await this.request(account, `/repos/${fullName}`)).data, account);
  }
  git(account, args, options = {}) {
    return this.runGit(['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=', '-c', 'credential.https://github.com.helper=manager',
      '-c', `credential.https://github.com.username=${account}`, '-c', 'credential.interactive=never', ...args], options);
  }
  networkGit(account, fullName, args, options) {
    const url = githubRepositoryURL(fullName);
    return this.git(account, ['-c', `credential.${url}.username=${account}`, '-c', `credential.${url}.useHttpPath=false`,
      '-c', `credential.${url}.helper=`, '-c', `credential.${url}.helper=manager`, ...args], options);
  }
  async optionalGit(account, args, options) {
    try { return await this.git(account, args, options); }
    catch (error) {
      if (error.gitMissing || (error.gitCode === 1 && ['config', 'symbolic-ref'].includes(args[0]))) return '';
      throw error;
    }
  }
  async directory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw Error('请选择有效的本地目录');
    let real;
    try { real = await fs.promises.realpath(value); if (!(await fs.promises.stat(real)).isDirectory()) throw Error(); }
    catch (cause) { const error = Error('本地目录不存在或无法访问，请重新选择'); error.localMissing = cause.code === 'ENOENT'; throw error; }
    return real;
  }
  async inspect(account, fullName, cwd, repository) {
    const result = { account, fullName, localPath: cwd || '', branch: '', ahead: 0, behind: 0, dirty: false, files: [], remote: '', hasRepository: false, hasCommits: false, hasUpstream: false, upstream: null, canPush: repository.canPush && !repository.archived };
    if (!cwd) return result;
    cwd = await this.directory(cwd); result.localPath = cwd;
    const root = (await this.optionalGit(account, ['rev-parse', '--show-toplevel'], { cwd })).trim();
    if (!root) return result;
    const realRoot = await this.directory(root);
    if (!samePath(cwd, realRoot)) throw Error('请选择 Git 仓库的根目录，不能关联其内部子目录');
    result.hasRepository = true;
    result.branch = (await this.optionalGit(account, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })).trim();
    result.hasCommits = !!(await this.optionalGit(account, ['rev-parse', '--verify', 'HEAD'], { cwd })).trim();
    result.files = parseStatus(await this.git(account, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd }));
    if (result.files.length > 20000) throw Error('待提交文件过多，请先通过 .gitignore 排除依赖和生成目录后重试');
    result.dirty = result.files.length > 0;
    const remote = (await this.optionalGit(account, ['config', '--get', 'remote.origin.url'], { cwd })).trim();
    const name = remoteName(remote);
    result.remote = name ? githubRepositoryURL(name) : remote ? '其他远程仓库' : '';
    result.remoteMatches = !!name && name.toLowerCase() === fullName.toLowerCase();
    if (result.hasCommits && result.branch) {
      result.upstream = (await this.optionalGit(account, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd })).trim() || null;
      result.hasUpstream = !!result.upstream;
      const count = (await this.optionalGit(account, ['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${result.branch}`], { cwd })).trim();
      if (count) [result.ahead, result.behind] = count.split(/\s+/).map(Number);
      else result.ahead = Number((await this.git(account, ['rev-list', '--count', 'HEAD'], { cwd })).trim()) || 0;
      if (result.ahead > 0) {
        const args = count ? ['diff', '--name-only', '-z', `refs/remotes/origin/${result.branch}...HEAD`] : ['ls-tree', '-r', '--name-only', '-z', 'HEAD'];
        result.pendingFiles = (await this.git(account, args, { cwd })).split('\0').filter(Boolean);
      }
    }
    return result;
  }
  async filePreview({ account: value, fullName, file } = {}) {
    const account = await this.account(value); fullName = githubRepositoryName(fullName);
    const cwd = await this.directory(this.localPath(account, fullName));
    // Local previews need fresh file membership, but no remote repository metadata or push permission.
    const state = await this.inspect(account, fullName, cwd, { canPush: false });
    const changed = state.files.find(item => item.path === file);
    if (typeof file !== 'string' || (!changed && !state.pendingFiles?.includes(file))) throw Error('文件不在待推送列表中');
    if (changed?.status === '??') {
      const real = await fs.promises.realpath(path.resolve(cwd, file));
      const relative = path.relative(cwd, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('无法预览仓库外部文件');
      const handle = await fs.promises.open(real, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return { text: '此文件类型不支持文本预览' };
        const buffer = Buffer.alloc(200000);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        return { text: bytes.includes(0) ? '二进制文件，不支持文本差异预览' : bytes.toString('utf8'), truncated: stat.size > bytesRead };
      } finally { await handle.close(); }
    }
    const paths = changed?.oldPath ? [changed.oldPath, file] : [file];
    const diff = async revisions => this.git(account, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...revisions, '--', ...paths], { cwd });
    const sections = [];
    if (state.pendingFiles?.includes(file)) {
      const remote = `refs/remotes/origin/${state.branch}`;
      const exists = (await this.optionalGit(account, ['rev-parse', '--verify', remote], { cwd })).trim();
      if (exists) sections.push('已提交，待推送\n' + await diff([`${remote}...HEAD`]));
      else {
        const committed = await this.git(account, ['show', `HEAD:${file}`], { cwd });
        sections.push(committed.includes('\0') ? '二进制文件，不支持文本预览' : '已提交，待首次推送\n' + committed);
      }
    }
    if (changed) sections.push('本地改动\n' + (state.hasCommits ? await diff(['HEAD']) : await diff(['--cached']) + await diff([])));
    const text = sections.join('\n\n') || '暂无可显示的文本差异';
    return { text: text.slice(0, 200000), truncated: text.length > 200000 };
  }
  async commitContext({ account: value, fullName, files } = {}) {
    const account = await this.account(value); fullName = githubRepositoryName(fullName);
    if (!Array.isArray(files) || !files.length || files.length > 20000 || files.some(file => typeof file !== 'string' || !file || file.includes('\0'))) throw Error('请选择需要提交的文件');
    const cwd = await this.directory(this.localPath(account, fullName));
    const state = await this.inspect(account, fullName, cwd, { canPush: false });
    const selected = new Set(files), rows = state.files.filter(file => selected.has(file.path));
    if (!state.hasRepository || rows.length !== selected.size) throw Error('所选文件已变化，请刷新文件列表后重新选择');
    if (rows.some(file => /U|AA|DD/.test(file.status))) throw Error('所选文件存在合并冲突，请先解决冲突');
    const context = { repository: fullName, branch: state.branch, totalFiles: rows.length, files: [], omittedFiles: 0, truncated: false };
    let remaining = 40000;
    for (const file of rows) {
      const entry = { path: file.path, status: file.status, ...(file.oldPath ? { oldPath: file.oldPath } : {}) };
      const overhead = JSON.stringify(entry).length;
      if (context.files.length >= 200 || remaining < overhead + 80) { context.omittedFiles++; context.truncated = true; continue; }
      const limit = Math.min(8000, remaining - overhead - 40);
      if (context.files.length >= 40 || limit < 200) {
        entry.omitted = true; context.truncated = true;
      } else if (file.status === '??') {
        const absolute = path.resolve(cwd, file.path), relative = path.relative(cwd, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('无法分析仓库外部文件');
        const stat = await fs.promises.lstat(absolute);
        if (stat.isSymbolicLink()) entry.diff = '符号链接：' + (await fs.promises.readlink(absolute)).slice(0, limit);
        else {
          const real = await fs.promises.realpath(absolute), realRelative = path.relative(cwd, real);
          if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw Error('无法分析仓库外部文件');
          if (!stat.isFile()) entry.diff = '非普通文件，省略内容';
          else {
            const handle = await fs.promises.open(real, 'r');
            try {
              const buffer = Buffer.alloc(limit), { bytesRead } = await handle.read(buffer, 0, limit, 0);
              const bytes = buffer.subarray(0, bytesRead);
              entry.diff = bytes.includes(0) ? '二进制文件，省略内容' : bytes.toString('utf8') || '新增空文件';
              entry.truncated = stat.size > bytesRead;
            } finally { await handle.close(); }
          }
        }
      } else {
        const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
        const diff = revisions => this.git(account, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', ...revisions, '--', ...paths], { cwd });
        const text = state.hasCommits ? await diff(['HEAD']) : await diff(['--cached']) + await diff([]);
        entry.diff = text.slice(0, limit) || '文件状态变化，无文本差异'; entry.truncated = text.length > limit;
      }
      // JSON escaping counts toward the model's input budget too.
      let size = JSON.stringify(entry).length;
      while (size >= remaining && entry.diff) {
        entry.diff = entry.diff.slice(0, Math.max(0, entry.diff.length - (size - remaining) - 40));
        entry.truncated = true; size = JSON.stringify(entry).length;
      }
      remaining -= size + 1;
      context.truncated ||= entry.truncated === true;
      context.files.push(entry);
    }
    return context;
  }
  async status({ account: value, fullName, cwd } = {}) {
    const account = await this.account(value); fullName = githubRepositoryName(fullName);
    const repository = await this.repository(account, fullName);
    const localPath = cwd || this.localPath(account, fullName);
    try { return await this.inspect(account, fullName, localPath, repository); }
    catch (error) {
      if (cwd || !error.localMissing) throw error;
      return { ...await this.inspect(account, fullName, '', repository), missingLocalPath: localPath };
    }
  }
  async exclusive(key, work) {
    if (process.platform === 'win32') key = key.toLowerCase();
    if (this.operations.has(key)) throw Error('该仓库正在执行操作，请等待完成后重试');
    this.operations.add(key); try { return await work(); } finally { this.operations.delete(key); }
  }
  async result(account, repository, cwd) {
    repository = { ...repository, localPath: cwd };
    return { repository, status: await this.inspect(account, repository.fullName, cwd, repository), cwd };
  }
  async validateTransport(account, fullName, cwd) {
    const url = githubRepositoryURL(fullName);
    const effective = (await this.git(account, ['ls-remote', '--get-url', url], { cwd })).trim();
    if (effective !== url) throw Error('Git 配置将仓库地址重写到了其他地址，请检查 url.insteadOf 后重试');
  }
  async clone({ account: value, fullName, parent } = {}) {
    const account = await this.account(value); fullName = githubRepositoryName(fullName);
    const repository = await this.repository(account, fullName), root = await this.directory(parent);
    const name = fullName.split('/')[1];
    if (process.platform === 'win32' && (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || /[. ]$/.test(name))) throw Error('仓库名称不能作为 Windows 目录名，请在 GitHub 修改名称');
    const cwd = path.join(root, name);
    return this.exclusive(cwd, async () => {
      try { await fs.promises.lstat(cwd); throw Error('目标目录已存在，请选择其他父目录；不会覆盖已有文件'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.validateTransport(account, fullName, root);
      await this.networkGit(account, repository.fullName, ['clone', '--', githubRepositoryURL(repository.fullName), cwd], { cwd: root, timeout: 5 * 60 * 1000 });
      this.savePath(account, fullName, cwd, repository);
      return this.result(account, repository, cwd);
    });
  }
  async bind({ account: value, fullName, cwd: valuePath } = {}) {
    const account = await this.account(value); fullName = githubRepositoryName(fullName);
    const repository = await this.repository(account, fullName), cwd = await this.directory(valuePath);
    return this.exclusive(cwd, async () => {
      const state = await this.inspect(account, fullName, cwd, repository);
      if (state.hasRepository && state.remote && !state.remoteMatches) throw Error('本地目录关联了另一个远程仓库，请选择对应仓库；不会修改原远程地址');
      if (!state.hasRepository) {
        await this.validateTransport(account, fullName, cwd);
        const remote = await this.networkGit(account, repository.fullName, ['ls-remote', '--heads', githubRepositoryURL(repository.fullName)], { cwd });
        if (remote.trim()) throw Error('远程仓库已有内容，请先克隆，再复制需要推送的文件；不会覆盖已有历史');
        await this.initialize(account, cwd);
        await this.ensureRemote(account, repository, cwd);
      }
      this.savePath(account, fullName, cwd, repository);
      return this.result(account, repository, cwd);
    });
  }
  async ensureRemote(account, repository, cwd) {
    const remote = (await this.optionalGit(account, ['config', '--get', 'remote.origin.url'], { cwd })).trim();
    if (remote && remoteName(remote).toLowerCase() !== repository.fullName.toLowerCase()) throw Error('本地远程地址与所选仓库不一致，已停止操作');
    if (!remote) await this.git(account, ['remote', 'add', 'origin', githubRepositoryURL(repository.fullName)], { cwd });
    else if (remote !== githubRepositoryURL(repository.fullName)) await this.git(account, ['remote', 'set-url', 'origin', githubRepositoryURL(repository.fullName)], { cwd });
    // Reject alternate push URLs: every application push targets the reviewed canonical origin.
    const pushURLs = (await this.optionalGit(account, ['config', '--get-all', 'remote.origin.pushurl'], { cwd })).trim().split(/\r?\n/).filter(Boolean);
    if (pushURLs.some(url => url !== githubRepositoryURL(repository.fullName))) throw Error('本地仓库配置了不同的推送地址，请检查 remote.origin.pushurl 后重试');
    const effective = await this.git(account, ['remote', 'get-url', '--push', '--all', 'origin'], { cwd });
    if (effective.trim().split(/\r?\n/).some(url => url !== githubRepositoryURL(repository.fullName))) {
      throw Error('Git 配置将推送地址重写到了其他地址，请检查 url.insteadOf 或 pushInsteadOf 后重试');
    }
    const fetchURL = (await this.git(account, ['remote', 'get-url', 'origin'], { cwd })).trim();
    if (fetchURL !== githubRepositoryURL(repository.fullName)) throw Error('Git 配置将仓库地址重写到了其他地址，请检查 url.insteadOf 后重试');
  }
  async update({ account: value, fullName } = {}) {
    const account = await this.account(value); fullName = githubRepositoryName(fullName);
    const repository = await this.repository(account, fullName), cwd = await this.directory(this.localPath(account, fullName));
    return this.exclusive(cwd, async () => {
      const state = await this.inspect(account, fullName, cwd, repository);
      if (!state.hasRepository || !state.hasCommits || !state.branch) throw Error('该目录没有可同步的 Git 分支，请先克隆仓库');
      if (state.dirty) throw Error('本地存在未提交的修改，请先提交或自行处理后同步；不会覆盖本地文件');
      await this.ensureRemote(account, repository, cwd);
      await this.networkGit(account, repository.fullName, ['fetch', '--no-tags', 'origin', `+refs/heads/${state.branch}:refs/remotes/origin/${state.branch}`], { cwd });
      const refreshed = await this.inspect(account, fullName, cwd, repository);
      if (!refreshed.behind) return { ...await this.result(account, repository, cwd), upToDate: true };
      await this.networkGit(account, repository.fullName, ['pull', '--ff-only', '--no-rebase', 'origin', state.branch], { cwd });
      return { ...await this.result(account, repository, cwd), upToDate: false };
    });
  }
  async identity(account, cwd) {
    const existingName = (await this.optionalGit(account, ['config', '--get', 'user.name'], { cwd })).trim();
    const existingEmail = (await this.optionalGit(account, ['config', '--get', 'user.email'], { cwd })).trim();
    if (existingName && existingEmail) return;
    let user = this.users.get(account);
    if (!user) { user = (await this.request(account, '/user')).data; this.users.set(account, user); }
    if (!ACCOUNT.test(user.login || '') || !Number.isSafeInteger(user.id)) throw Error('GitHub 用户信息异常，请重新登录');
    if (!existingName) await this.git(account, ['config', '--local', 'user.name', String(user.name || user.login).replace(/[\r\n\0]/g, ' ')], { cwd });
    if (!existingEmail) await this.git(account, ['config', '--local', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`], { cwd });
  }
  async initialize(account, cwd) {
    await this.git(account, ['init', '--initial-branch=main'], { cwd });
    // Ignore dependency caches only in a newly initialized repository; preserve the project's .gitignore.
    await fs.promises.appendFile(path.join(cwd, '.git', 'info', 'exclude'), '\n# Pi Halo: local dependency caches\nnode_modules/\n.venv/\nvenv/\n__pycache__/\n', 'utf8');
  }
  async upload({ account: value, fullName, cwd: valuePath, files = [], message = '' } = {}) {
    const account = await this.account(value); fullName = githubRepositoryName(fullName);
    if (!Array.isArray(files) || files.length > 20000 || files.some(file => typeof file !== 'string' || !file || file.includes('\0'))) throw Error('请选择需要提交的文件');
    if (typeof message !== 'string' || (files.length && !message.trim()) || message.length > 10000 || message.includes('\0')) throw Error('请填写有效的提交说明');
    const repository = await this.repository(account, fullName);
    if (!repository.canPush || repository.archived) throw Error('当前账户没有该仓库的推送权限，或仓库已归档');
    const cwd = await this.directory(valuePath || this.localPath(account, fullName));
    return this.exclusive(cwd, async () => {
      let state = await this.inspect(account, fullName, cwd, repository);
      if (!state.hasRepository) {
        await this.validateTransport(account, fullName, cwd);
        const remote = await this.networkGit(account, repository.fullName, ['ls-remote', '--heads', githubRepositoryURL(repository.fullName)], { cwd });
        if (remote.trim()) throw Error('远程仓库已有内容，请先克隆，再复制需要推送的文件；不会覆盖已有历史');
        await this.initialize(account, cwd);
        state = await this.inspect(account, fullName, cwd, repository);
      }
      if (!state.branch) throw Error('当前处于分离 HEAD 状态，请先切换到分支后推送');
      if (!files.length && !state.hasCommits) throw Error('请选择需要提交的文件');
      const selected = new Set(files), selectedRows = state.files.filter(file => selected.has(file.path));
      if (selectedRows.length !== selected.size) throw Error('所选文件已变化，请刷新文件列表后重新选择');
      if (selectedRows.some(file => /U|AA|DD/.test(file.status))) throw Error('所选文件存在合并冲突，请先解决冲突');
      await this.ensureRemote(account, repository, cwd);
      await this.networkGit(account, repository.fullName, ['fetch', '--no-tags', 'origin'], { cwd });
      if (!state.hasCommits) {
        const remote = await this.networkGit(account, repository.fullName, ['ls-remote', '--heads', 'origin'], { cwd });
        if (remote.trim()) throw Error('远程仓库已有提交，本地没有共同历史，请先克隆；不会覆盖远程内容');
      } else {
        const remoteBranch = (await this.optionalGit(account, ['rev-parse', '--verify', `refs/remotes/origin/${state.branch}`], { cwd })).trim();
        if (remoteBranch) {
          const count = (await this.git(account, ['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${state.branch}`], { cwd })).trim().split(/\s+/).map(Number);
          if (count[1] > 0) throw Error('远程分支已有新提交，请先处理本地修改并同步后推送；不会强制覆盖');
        }
      }
      if (files.length) {
        await this.identity(account, cwd);
        // Literal NUL-delimited pathspecs handle Unicode, whitespace, option-like names and renames.
        const paths = [...new Set(selectedRows.flatMap(file => file.oldPath ? [file.path, file.oldPath] : [file.path]))];
        const input = paths.join('\0') + '\0';
        // A staged rename's original path is no longer in the index; stage its destination only.
        const addPaths = selectedRows.filter(file => file.status[0] !== 'D').map(file => file.path);
        if (addPaths.length) await this.git(account, ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd, input: addPaths.join('\0') + '\0' });
        await this.git(account, ['--literal-pathspecs', 'commit', '--only', '-m', message.trim(), '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd, input });
      }
      this.savePath(account, fullName, cwd, repository);
      try { await this.networkGit(account, repository.fullName, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${state.branch}`], { cwd }); }
      catch (error) { throw Error(`本地提交已保存，但推送未完成。${error.message}；处理后可点击“推送”重试`); }
      return this.result(account, repository, cwd);
    });
  }
  async create({ account: value, name, description = '', private: isPrivate = true } = {}) {
    const account = await this.account(value);
    githubRepositoryName(`${account}/${name}`);
    if (typeof description !== 'string' || description.length > 1000) throw Error('仓库描述过长，请缩短后重试');
    const repository = this.row((await this.request(account, '/user/repos', { method: 'POST', body: { name, description, private: isPrivate !== false, auto_init: false } })).data, account);
    this.invalidate(account);
    return { repository, status: null, cwd: null };
  }
}
