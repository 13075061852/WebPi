import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchElectronApp, waitUntil } from '../helpers/electron-app.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-workspace-memory-'));
for (const name of ['profile', 'project-a', 'project-b', 'agent', 'roaming', 'local', 'gh']) fs.mkdirSync(path.join(fixture, name));
const profile = path.join(fixture, 'profile'), a = path.join(fixture, 'project-a'), b = path.join(fixture, 'project-b');
const system = process.env.SystemRoot || 'C:/Windows';
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.dirname(process.execPath), path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: path.join(fixture, 'agent'), PI_OFFLINE: '1',
  GH_CONFIG_DIR: path.join(fixture, 'gh'), GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
// Create real SDK session files without credentials or model calls.
process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
const { SessionManager } = await import('@earendil-works/pi-coding-agent');
function conversation(cwd, text) {
  const session = SessionManager.create(cwd);
  session.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
  return session.getSessionFile();
}
const fileA = conversation(a, '项目 A 的对话'), fileB = conversation(b, '项目 B 先前选择的对话');
conversation(b, '项目 B 更新的另一个对话');
const settingsFile = path.join(profile, 'halo-settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ cwd: a, projects: [{ cwd: a, lastSession: fileA }, { cwd: b, lastSession: fileB }],
  githubRepositories: { 'fixture:fixture/project-b': { account: 'fixture', fullName: 'fixture/project-b', localPath: b } },
  globalProxy: { mode: 'direct' } }));
const norm = s => String(s || '').replaceAll('\\', '/').toLowerCase();
let app;
let projectName = 'project-a';
let repositoryName = 'project-b';
try {
  app = await launchElectronApp({ fixture, profile, env });
  await app.evaluate("document.querySelector('.nav-item[data-tab=git]').click()");
  await waitUntil(() => app.evaluate(`!![...document.querySelectorAll('.project-conversation-name')].find(n=>n.dataset.conversationFile===${JSON.stringify(fileB)})`), 'Conversation list incomplete');
  async function assertSeparated() {
    await waitUntil(() => app.evaluate("document.querySelectorAll('#projList .project-group').length === 1 && document.querySelectorAll('#gitRepositoryList .project-group').length === 1"), 'Project and repository lists incomplete');
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#projList .project-toggle span')].map(n=>n.textContent)"), [projectName]);
    assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#gitRepositoryList .project-toggle span')].map(n=>n.textContent)"), [repositoryName]);
    assert.deepEqual((await app.evaluate('window.halo.projectsList()')).data.map(p => norm(p.cwd)), [norm(a)]);
    assert.equal(await app.evaluate("document.querySelectorAll('#projList .project-start, #gitRepositoryList .project-start, .project-runs').length"), 0, 'Project and repository launch controls are removed');
    assert.equal(await app.evaluate("['projectRunStart','projectRunList','projectRunStop','onProjectRun'].some(key=>key in window.halo)"), false, 'Removed launch APIs must not remain exposed');
  }
  await assertSeparated();
  await app.evaluate("document.querySelector('#projList details').open=true;document.querySelector('#projList .project-rename').click()");
  assert.equal(await app.evaluate("document.querySelector('#projectName').value"), projectName);
  await app.evaluate("document.querySelector('#projectName').value='取消的名称';document.querySelector('#projectRenameModal [data-close]').click()");
  await assertSeparated();
  await app.evaluate("document.querySelector('#projList details').open=true;document.querySelector('#projList .project-rename').click();document.querySelector('#projectName').value='材料分析';document.querySelector('#projectRenameForm').requestSubmit()");
  projectName = '材料分析';
  await waitUntil(() => app.evaluate("document.querySelector('#projList .project-toggle span').textContent==='材料分析'"), 'Renamed project did not render');
  assert.ok(fs.existsSync(a), 'Rename preserves project directory');
  await app.evaluate("document.querySelector('#gitRepositoryList details').open=true;document.querySelector('#gitRepositoryList .project-rename').click();document.querySelector('#projectName').value='本地材料仓库';document.querySelector('#projectRenameForm').requestSubmit()");
  repositoryName = '本地材料仓库';
  await waitUntil(() => app.evaluate("document.querySelector('#gitRepositoryList .project-toggle span').textContent==='本地材料仓库'"), 'Repository alias did not render');
  const localRepository = (await app.evaluate('window.halo.gitLocalRepositories()')).data.repositories[0];
  assert.equal(localRepository.fullName, 'fixture/project-b');
  assert.equal(localRepository.name, 'project-b');
  assert.equal(norm(localRepository.localPath), norm(b));
  await app.evaluate("document.querySelector('#gitRepositoryList .project-toggle').click()");
  await waitUntil(() => app.evaluate(`window.halo.getState().then(r=>r.data.cwd.replaceAll('\\\\','/').toLowerCase()===${JSON.stringify(norm(b))})`), 'Repository did not open');
  await assertSeparated();
  await app.evaluate(`[...document.querySelectorAll('.project-conversation-name')].find(n=>n.dataset.conversationFile===${JSON.stringify(fileB)}).click()`);
  await waitUntil(() => app.evaluate(`document.querySelector('#messages').textContent.includes('项目 B 先前选择的对话')`), 'Selected conversation did not render');
  await app.evaluate("document.querySelector('.nav-item[data-tab=git]').click()");
  const beforeClose = await app.evaluate("JSON.parse(localStorage.getItem('halo-workspace'))");
  assert.equal(norm(beforeClose.session), norm(fileB), JSON.stringify(beforeClose));
  await app.close(); app = null;
  // Model a stale startup default. The renderer must retain its shutdown
  // selection while the bridge first announces this different project.
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.cwd = a; fs.writeFileSync(settingsFile, JSON.stringify(settings));
  app = await launchElectronApp({ fixture, profile, env });
  await assertSeparated();
  const restored = await app.evaluate('window.halo.getState().then(r=>r.data)');
  assert.equal(norm(restored.cwd), norm(b)); assert.equal(norm(restored.sessionFile), norm(fileB));
  assert.equal(await app.evaluate("document.querySelector('.nav-item.active').dataset.tab"), 'git');
  assert.equal(await app.evaluate("document.querySelector('#messages').textContent.includes('项目 B 先前选择的对话')"), true);
  const shot = await app.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(fixture, 'restored-workspace.png'), Buffer.from(shot.result.data, 'base64'));
  await app.evaluate("document.querySelector('.nav-item[data-tab=chat]').click();document.querySelector('#btnNewSession').click()");
  await waitUntil(async () => (await app.evaluate('window.halo.getState().then(r=>r.data)')).messageCount === 0, 'Blank conversation missing');
  await app.close(); app = null;
  app = await launchElectronApp({ fixture, profile, env });
  const draft = await app.evaluate('window.halo.getState().then(r=>r.data)');
  assert.equal(norm(draft.cwd), norm(b)); assert.equal(draft.messageCount, 0);
  assert.equal(await app.evaluate("document.querySelector('.nav-item.active').dataset.tab"), 'chat');
  assert.equal(await app.evaluate("document.querySelector('#messages').textContent.includes('项目 B 先前选择的对话')"), false);
  await app.close(); app = null;
  console.log(JSON.stringify({ ok: true, fixture, checks: ['three application launches', 'exact project', 'older selected conversation', 'repository tab', 'stale startup state', 'blank conversation', 'project tab'] }));
} finally { await app?.stop(); }
