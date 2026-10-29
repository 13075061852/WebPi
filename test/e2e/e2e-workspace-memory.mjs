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
fs.writeFileSync(settingsFile, JSON.stringify({ cwd: a, projects: [{ cwd: a, lastSession: fileA }, { cwd: b, lastSession: fileB }], globalProxy: { mode: 'direct' } }));
const norm = s => String(s || '').replaceAll('\\', '/').toLowerCase();
let app;
try {
  app = await launchElectronApp({ fixture, profile, env });
  await waitUntil(() => app.evaluate(`!![...document.querySelectorAll('.project-conversation-name')].find(n=>n.dataset.conversationFile===${JSON.stringify(fileB)})`), 'Conversation list incomplete');
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
