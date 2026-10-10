import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitRepositories, githubRepositoryURL, runRepositoryGit } from '../src/main/git-repositories.mjs';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'halo-git-offline-'));
const home = path.join(root, 'isolated-home'), remotes = path.join(root, 'remotes'), checkoutParent = path.join(root, '克隆 演示');
await fs.promises.mkdir(home); await fs.promises.mkdir(remotes); await fs.promises.mkdir(checkoutParent);
const globalConfig = path.join(home, 'empty-gitconfig'); await fs.promises.writeFile(globalConfig, '');
const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
const raw = (args, options = {}) => runRepositoryGit(args, { ...options, env });
const operations = []; let failPush = false;
const runGit = async (args, options) => {
  operations.push(args);
  if (failPush && args.includes('push')) { failPush = false; throw Error('离线网络失败'); }
  if (args.includes('get-url')) return raw(['config', '--get', 'remote.origin.url'], options);
  if (args.includes('ls-remote') && args.includes('--get-url')) return args.at(-1) + '\n';
  // Production still receives only validated HTTPS URLs. Git's fixture-only URL rewrite stays in this isolated child.
  return raw(['-c', `url.${pathToFileURL(remotes + path.sep).href}.insteadOf=https://github.com/octocat/`, '-c', 'protocol.file.allow=always', ...args], options);
};
const token = 'offline-fixture-token';
let invalidated = false;
const auth = { status: async () => ({ accounts: ['octocat', 'second-user'], selectedAccount: 'octocat' }),
  credential: async account => { assert.ok(['octocat', 'second-user'].includes(account)); return token; }, invalidate: () => { invalidated = true; } };
const store = { data: {}, set(key, value) { this.data[key] = value; } };
const meta = name => ({ id: name.length, name, full_name: `octocat/${name}`, private: true, owner: { login: 'octocat' },
  permissions: { push: true }, default_branch: 'main', description: '离线仓库' });
const requests = []; let failure = 0;
const fetchImpl = async (url, options) => {
  requests.push({ url, options });
  assert.equal(options.headers.Authorization, `Bearer ${token}`);
  assert.equal(options.redirect, 'error');
  if (failure) return new Response('{}', { status: failure });
  const parsed = new URL(url);
  if (parsed.pathname === '/user') return Response.json({ id: 1234, login: 'octocat', name: 'Offline 用户' });
  if (options.method === 'POST') { const body = JSON.parse(options.body); assert.equal(body.auto_init, false); return Response.json(meta(body.name)); }
  if (parsed.pathname === '/user/repos') {
    assert.equal(parsed.searchParams.get('affiliation'), 'owner,collaborator,organization_member');
    assert.equal(parsed.searchParams.get('visibility'), 'all');
    const page = Number(parsed.searchParams.get('page'));
    const data = page === 1 ? Array.from({ length: 100 }, (_, i) => meta(i ? `repo-${i}` : 'demo')) : [meta('empty'), meta('demo')];
    return Response.json(data, { headers: page === 1 ? { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' } : {} });
  }
  const name = parsed.pathname.split('/').at(-1);
  return Response.json(meta(name));
};
const repositories = new GitRepositories({ auth, store, fetchImpl, runGit });
const localPreview = new GitRepositories({
  auth: { ...auth, credential() { throw Error('Local preview must not request GitHub credentials'); } }, store, runGit,
  fetchImpl() { throw Error('Local preview must not request remote repository metadata'); }
});
const initialize = async (cwd, bare = false) => {
  await fs.promises.mkdir(cwd);
  await raw(['init', ...(bare ? ['--bare'] : []), '--initial-branch=main'], { cwd });
  if (!bare) { await raw(['config', 'user.name', 'Fixture User'], { cwd }); await raw(['config', 'user.email', 'fixture@example.invalid'], { cwd }); }
};
const commit = async (cwd, name, contents, message) => {
  await fs.promises.writeFile(path.join(cwd, name), contents);
  await raw(['add', '--', name], { cwd }); await raw(['commit', '-m', message], { cwd });
};
try {
  const bare = path.join(remotes, 'demo.git'), emptyBare = path.join(remotes, 'empty.git'), source = path.join(root, 'source');
  await initialize(bare, true); await initialize(emptyBare, true); await initialize(source);
  await commit(source, 'README.md', 'baseline\n', 'baseline');
  await commit(source, 'notes.txt', 'original notes\n', 'notes');
  await raw(['remote', 'add', 'origin', pathToFileURL(bare).href], { cwd: source });
  await raw(['push', '-u', 'origin', 'main'], { cwd: source });
  const listed = await repositories.list({});
  assert.equal(listed.total, 101, 'All API pages merged, repeated repo deduplicated');
  assert.equal(listed.repositories[0].private, true);
  const before = requests.length; await repositories.list({}); assert.equal(requests.length, before, 'Cache reused');
  await repositories.list({ force: true }); assert.equal(requests.length, before + 2);
  const clone = await repositories.clone({ fullName: 'octocat/demo', parent: checkoutParent });
  const cwd = clone.cwd;
  assert.equal(clone.status.branch, 'main'); assert.equal(clone.status.hasUpstream, true); assert.equal(clone.status.remote, githubRepositoryURL('octocat/demo'));
  assert.equal(clone.repository.localPath, cwd);
  assert.equal((await repositories.list({})).repositories[0].localPath, cwd);
  const localAfterClone = await repositories.local({});
  assert.equal(localAfterClone.total, 1, 'Remote-only repositories do not appear in the local sidebar');
  assert.equal(localAfterClone.repositories[0].fullName, 'octocat/demo');
  await assert.rejects(repositories.clone({ fullName: 'octocat/demo', parent: checkoutParent }), /已存在/);
  await fs.promises.writeFile(path.join(cwd, 'README.md'), 'selected update\n');
  assert.equal(localPreview.cache.size, 0, 'Preview is tested without a cached GitHub repository list');
  assert.match((await localPreview.filePreview({ fullName: 'octocat/demo', file: 'README.md' })).text, /selected update/);
  await fs.promises.writeFile(path.join(cwd, 'preview-untracked.txt'), 'new local text');
  assert.equal((await localPreview.filePreview({ fullName: 'octocat/demo', file: 'preview-untracked.txt' })).text, 'new local text');
  await fs.promises.writeFile(path.join(cwd, 'preview-untracked.txt'), '');
  assert.equal((await localPreview.filePreview({ fullName: 'octocat/demo', file: 'preview-untracked.txt' })).text, '');
  await fs.promises.unlink(path.join(cwd, 'preview-untracked.txt'));
  await assert.rejects(localPreview.filePreview({ fullName: 'octocat/demo', file: 'preview-untracked.txt' }), /待推送列表/);
  await assert.rejects(localPreview.filePreview({ fullName: 'octocat/demo', file: '../outside' }), /待推送列表/);
  await assert.rejects(localPreview.filePreview({ account: 'not-authorized', fullName: 'octocat/demo', file: 'README.md' }), /登录/);
  await fs.promises.writeFile(path.join(cwd, 'notes.txt'), 'keep staged\n');
  await raw(['add', '--', 'notes.txt'], { cwd });
  const state = await repositories.status({ fullName: 'octocat/demo' });
  assert.equal(state.files.find(file => file.path === 'notes.txt').staged, true);
  const requestsBeforeContext = requests.length;
  const context = await localPreview.commitContext({ fullName: 'octocat/demo', cwd: root, files: ['README.md'] });
  assert.deepEqual(context.files.map(file => file.path), ['README.md']);
  assert.match(context.files[0].diff, /selected update/); assert.doesNotMatch(JSON.stringify(context), /keep staged/);
  assert.equal(requests.length, requestsBeforeContext, 'Commit context reads only the saved local repository without REST or credentials');
  await assert.rejects(localPreview.commitContext({ fullName: 'octocat/demo', files: ['../outside'] }), /已变化/);
  await assert.rejects(localPreview.commitContext({ account: 'not-authorized', fullName: 'octocat/demo', files: ['README.md'] }), /登录/);
  await assert.rejects(localPreview.commitContext({ fullName: 'octocat/demo', files: [] }), /请选择/);
  const samples = { 'empty.txt': '', 'binary.bin': Buffer.from([1, 0, 2]), 'large.txt': 'x'.repeat(60000) };
  for (const [name, data] of Object.entries(samples)) await fs.promises.writeFile(path.join(cwd, name), data);
  const sampled = await localPreview.commitContext({ fullName: 'octocat/demo', files: Object.keys(samples) });
  assert.match(sampled.files.find(file => file.path === 'empty.txt').diff, /空文件/);
  assert.match(sampled.files.find(file => file.path === 'binary.bin').diff, /二进制/);
  assert.equal(sampled.files.find(file => file.path === 'large.txt').truncated, true);
  assert.ok(JSON.stringify(sampled).length < 45000);
  for (const name of Object.keys(samples)) await fs.promises.unlink(path.join(cwd, name));
  const uploaded = await repositories.upload({ fullName: 'octocat/demo', files: ['README.md'], message: '选择一个文件' });
  assert.equal(uploaded.status.files.find(file => file.path === 'notes.txt').staged, true, 'Unselected staged changes preserved');
  assert.equal((await raw(['show', 'main:notes.txt'], { cwd: bare })).trim(), 'original notes', 'Other staged change not included in pushed commit');
  assert.equal((await raw(['show', 'main:README.md'], { cwd: bare })).trim(), 'selected update');
  await assert.rejects(repositories.update({ fullName: 'octocat/demo' }), /未提交/);
  await raw(['restore', '--staged', '--worktree', '--', 'notes.txt'], { cwd });
  await raw(['pull', '--ff-only', 'origin', 'main'], { cwd: source });
  await commit(source, 'server.txt', 'remote change', 'remote update'); await raw(['push', 'origin', 'main'], { cwd: source });
  const updated = await repositories.update({ fullName: 'octocat/demo' });
  assert.equal(updated.upToDate, false);
  assert.equal(updated.status.dirty, false); assert.equal(await fs.promises.readFile(path.join(cwd, 'server.txt'), 'utf8'), 'remote change');
  const pullsBefore = operations.filter(args => args.includes('pull')).length;
  const current = await repositories.update({ fullName: 'octocat/demo' });
  assert.equal(current.upToDate, true);
  assert.equal(operations.filter(args => args.includes('pull')).length, pullsBefore, 'Already current repositories skip pull');
  await commit(cwd, 'local.txt', 'local branch', 'local divergent');
  assert.ok((await repositories.status({ fullName: 'octocat/demo' })).pendingFiles.includes('local.txt'));
  const committedPreview = await localPreview.filePreview({ fullName: 'octocat/demo', file: 'local.txt' });
  assert.match(committedPreview.text, /已提交，待推送/); assert.match(committedPreview.text, /local branch/);
  await assert.rejects(localPreview.commitContext({ fullName: 'octocat/demo', files: ['local.txt'] }), /已变化/, 'Already committed content is excluded from the next commit description');
  await commit(source, 'remote.txt', 'remote branch', 'remote divergent'); await raw(['push', 'origin', 'main'], { cwd: source });
  await assert.rejects(repositories.update({ fullName: 'octocat/demo' }), /分叉|覆盖/);
  await fs.promises.writeFile(path.join(cwd, 'README.md'), 'must stay uncommitted');
  const head = (await raw(['rev-parse', 'HEAD'], { cwd })).trim();
  await assert.rejects(repositories.upload({ fullName: 'octocat/demo', files: ['README.md'], message: 'do not overwrite' }), /远程分支已有/);
  assert.equal((await raw(['rev-parse', 'HEAD'], { cwd })).trim(), head, 'Behind/diverged upload refused before commit');
  const newProject = path.join(root, '新项目'); await fs.promises.mkdir(newProject);
  await fs.promises.writeFile(path.join(newProject, 'README.md'), 'first selected');
  await fs.promises.writeFile(path.join(newProject, 'not-selected.md'), 'keep outside commit');
  await fs.promises.mkdir(path.join(newProject, 'node_modules')); await fs.promises.writeFile(path.join(newProject, 'node_modules', 'dependency.js'), 'ignored dependency');
  const bound = await repositories.bind({ fullName: 'octocat/empty', cwd: newProject });
  assert.equal(bound.status.hasRepository, true); assert.equal(bound.status.hasCommits, false);
  assert.equal(bound.status.files.some(file => file.path.startsWith('node_modules/')), false);
  await raw(['add', '--', 'not-selected.md'], { cwd: newProject });
  const initialContext = await localPreview.commitContext({ fullName: 'octocat/empty', files: ['README.md', 'not-selected.md'] });
  assert.match(initialContext.files.find(file => file.path === 'README.md').diff, /first selected/);
  assert.match(initialContext.files.find(file => file.path === 'not-selected.md').diff, /keep outside commit/);
  failPush = true;
  await assert.rejects(repositories.upload({ fullName: 'octocat/empty', files: ['README.md'], message: 'first selected commit' }), /本地提交已保存/);
  const retryState = await repositories.status({ fullName: 'octocat/empty' });
  assert.equal(retryState.hasUpstream, false); assert.equal(retryState.hasCommits, true); assert.ok(retryState.ahead > 0);
  const firstPushPreview = await localPreview.filePreview({ fullName: 'octocat/empty', file: 'README.md' });
  assert.match(firstPushPreview.text, /已提交，待首次推送/); assert.match(firstPushPreview.text, /first selected/);
  assert.equal(retryState.files.find(file => file.path === 'not-selected.md').staged, true);
  await repositories.upload({ fullName: 'octocat/empty', files: [], message: '' });
  assert.equal((await raw(['show', 'main:README.md'], { cwd: emptyBare })).trim(), 'first selected');
  assert.equal((await raw(['ls-tree', '--name-only', 'main'], { cwd: emptyBare })).trim(), 'README.md');
  assert.equal((await raw(['config', '--local', '--get', 'user.email'], { cwd: newProject })).trim(), '1234+octocat@users.noreply.github.com');
  assert.equal(await fs.promises.readFile(globalConfig, 'utf8'), '', 'Commit identity remains repository local');
  const weird = process.platform === 'win32' ? '--演示 [one].md' : ':演示 [one] --.md'; await fs.promises.writeFile(path.join(newProject, weird), 'literal path');
  await repositories.upload({ fullName: 'octocat/empty', files: [weird], message: 'literal file' });
  assert.equal(await raw(['show', `main:${weird}`], { cwd: emptyBare }), 'literal path');
  await raw(['mv', '--', 'README.md', '改名 文件.md'], { cwd: newProject });
  const renamed = await repositories.status({ fullName: 'octocat/empty' });
  assert.equal(renamed.files.find(file => file.path === '改名 文件.md').oldPath, 'README.md');
  const renameContext = await localPreview.commitContext({ fullName: 'octocat/empty', files: ['改名 文件.md'] });
  assert.equal(renameContext.files[0].oldPath, 'README.md'); assert.match(renameContext.files[0].diff, /rename from/);
  await repositories.upload({ fullName: 'octocat/empty', files: ['改名 文件.md'], message: 'rename selected' });
  const tree = await raw(['ls-tree', '-z', '--name-only', 'main'], { cwd: emptyBare });
  assert.equal(tree.includes('README.md'), false); assert.ok(tree.includes('改名 文件.md'));
  await fs.promises.unlink(path.join(newProject, '改名 文件.md'));
  assert.match((await localPreview.commitContext({ fullName: 'octocat/empty', files: ['改名 文件.md'] })).files[0].diff, /deleted file mode/);
  await repositories.upload({ fullName: 'octocat/empty', files: ['改名 文件.md'], message: 'delete selected' });
  assert.equal((await raw(['ls-tree', '-z', '--name-only', 'main'], { cwd: emptyBare })).includes('改名 文件.md'), false);
  await raw(['rm', '--', weird], { cwd: newProject });
  await repositories.upload({ fullName: 'octocat/empty', files: [weird], message: 'staged deletion selected' });
  assert.equal((await raw(['ls-tree', '-z', '--name-only', 'main'], { cwd: emptyBare })).includes(weird), false);
  await assert.rejects(repositories.upload({ fullName: 'octocat/empty', files: ['../outside'], message: 'reject' }), /已变化/);
  await assert.rejects(repositories.upload({ fullName: 'octocat/empty', files: ['--all'], message: 'reject' }), /已变化/);
  const fresh = path.join(root, 'existing-remote-project'); await fs.promises.mkdir(fresh); await fs.promises.writeFile(path.join(fresh, 'keep.txt'), 'must remain');
  await assert.rejects(repositories.bind({ fullName: 'octocat/demo', cwd: fresh }), /已有内容/);
  assert.equal(fs.existsSync(path.join(fresh, '.git')), false, 'Existing remote cannot silently initialize unrelated history');
  await assert.rejects(repositories.bind({ fullName: 'octocat/demo', cwd: newProject }), /另一个远程/);
  const missingName = 'octocat/missing'; store.data.githubRepositories[repositories.mappingKey('octocat', missingName)] = { localPath: path.join(root, 'removed-project') };
  const missing = await repositories.status({ fullName: missingName });
  assert.equal(missing.localPath, ''); assert.equal(missing.hasRepository, false); assert.ok(missing.missingLocalPath);
  await raw(['config', '--local', 'remote.origin.pushurl', 'https://github.com/other/wrong.git'], { cwd: newProject });
  await assert.rejects(repositories.upload({ fullName: 'octocat/empty', files: [], message: '' }), /不同的推送地址/);
  await raw(['config', '--local', '--unset-all', 'remote.origin.pushurl'], { cwd: newProject });
  const rewritten = new GitRepositories({ auth, store, fetchImpl, runGit: async (args, options) => args.includes('get-url') ? 'https://evil.invalid/repo.git\n' : runGit(args, options) });
  await assert.rejects(rewritten.upload({ fullName: 'octocat/empty', files: [], message: '' }), /重写/);
  const rewrittenClone = new GitRepositories({ auth, store, fetchImpl, runGit: async args => {
    assert.equal(args.includes('clone'), false, 'Refuse rewritten clone transport before network');
    return 'https://evil.invalid/repo.git\n';
  } });
  await assert.rejects(rewrittenClone.clone({ fullName: 'octocat/not-cloned', parent: checkoutParent }), /重写/);
  let releaseList;
  const racingList = new GitRepositories({ auth, store, fetchImpl: async () => new Promise(resolve => { releaseList = () => resolve(Response.json([meta('demo')])); }), runGit });
  const pendingList = racingList.list({}); await new Promise(resolve => setImmediate(resolve));
  racingList.invalidate('octocat'); releaseList(); await assert.rejects(pendingList, /授权已更新/);
  assert.equal(racingList.cache.size, 0, 'Invalidated in-flight account list cannot refill cache');
  const localStore = { data: { githubRepositories: {
    ...structuredClone(store.data.githubRepositories), 'second-user:octocat/legacy': { localPath: source }
  } }, set() { throw Error('Local list must not modify persisted mappings'); } };
  const localOnly = new GitRepositories({ store: localStore,
    auth: { status() { throw Error('Local list must not require GitHub login'); }, credential() { throw Error('Local list must not request credentials'); } },
    fetchImpl() { throw Error('Local list must not call REST'); }, runGit() { throw Error('Local list must not run Git'); } });
  const allLocal = await localOnly.local({});
  assert.equal(allLocal.total, 3, 'Restart with no cache retains cloned, bound and legacy local repositories');
  const persisted = allLocal.repositories.find(row => row.fullName === 'octocat/demo');
  assert.equal(persisted.description, '离线仓库'); assert.equal(persisted.private, true); assert.equal(persisted.canPush, true);
  const legacy = allLocal.repositories.find(row => row.fullName === 'octocat/legacy');
  assert.equal(legacy.account, 'second-user'); assert.equal(legacy.name, 'legacy'); assert.equal(legacy.defaultBranch, 'main');
  assert.equal(legacy.canPush, undefined, 'Legacy local mapping has unknown permission; live management status determines upload access');
  assert.equal((await localOnly.local({ account: 'octocat' })).total, 2);
  assert.equal((await localOnly.local({ account: 'second-user' })).total, 1);
  assert.equal(allLocal.repositories.some(row => row.fullName === missingName), false, 'Missing mapped directory is hidden');
  assert.ok(localStore.data.githubRepositories[repositories.mappingKey('octocat', missingName)], 'Missing mapping is preserved');
  const created = await repositories.create({ name: 'created', description: 'test', private: true });
  assert.equal(created.repository.private, true); assert.equal(created.cwd, null);
  await assert.rejects(repositories.create({ name: '../../escape' }), /有效/);
  await assert.rejects(repositories.status({ fullName: 'https://bad.invalid/repo' }), /有效/);
  failure = 401; repositories.invalidate(); await assert.rejects(repositories.list({ force: true }), /授权已过期/); assert.equal(invalidated, true);
  assert.equal(JSON.stringify(store.data).includes(token), false);
  assert.equal(JSON.stringify(clone).includes(token), false);
  assert.equal(operations.some(args => args.some(value => value.includes(token))), false, 'No token in Git command line');
  assert.ok(operations.some(args => args.includes('pull') && args.includes('--ff-only')));
  assert.equal(operations.some(args => args.some(value => /^--force/.test(value))), false);
  console.log('PASS offline GitHub pagination/cache, clone/bind, selected-only commit, push/retry, ff-only pull, dirty/diverged safety, literal paths and token isolation');
} finally {
  const absolute = path.resolve(root), expected = path.resolve(os.tmpdir()) + path.sep;
  if (!absolute.startsWith(expected) || !path.basename(absolute).startsWith('halo-git-offline-')) throw Error('Unsafe fixture cleanup');
  await fs.promises.rm(absolute, { recursive: true, force: true });
}
