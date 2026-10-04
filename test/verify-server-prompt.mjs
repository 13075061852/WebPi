import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatePi } from './helpers/isolated-real-pi.mjs';

const isolated = isolatePi('server-prompt');
const { fixture, project } = isolated;
let bridge;
try {
  const { PiBridge, HaloStore, loadPi } = await import('../src/main/pi-bridge.mjs');
  const { resolvePiEntry } = await import('../src/main/pi-runtime.mjs');
  const { buildSystemPrompt } = await import(new URL('./core/system-prompt.js', pathToFileURL(resolvePiEntry())).href);
  const sdk = await loadPi();
  bridge = new PiBridge(new HaloStore(path.join(fixture, 'halo.json')), {}, { sessionDir: path.join(fixture, 'sessions') });
  bridge.modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
  bridge.servers = { list: () => [
    { id: 'a', name: 'Server A', username: 'test', host: 'example.invalid', port: 22 },
    { id: 'b', name: 'Server B', username: 'test', host: 'other.invalid', port: 22 },
  ] };
  await bridge.start(project);
  const promptFor = async (session, prompt = '检查范围', base = 'base') => buildSystemPrompt(
    (await session.extensionRunner.emitBeforeAgentStart(prompt, undefined, {
      cwd: session.sessionManager.getCwd(),
      forceSystemPrompt: base,
    })).systemPromptOptions,
  );
  await bridge.newSession('a');
  const sessionA = bridge.session;
  assert.equal(PiBridge.normPath(sessionA.sessionManager.getCwd()), PiBridge.normPath(bridge.serverWorkspace('a')));
  for (const tool of ['preview_inspect', 'preview_control', 'icon_library', 'servers_list', 'ssh_exec', 'server_copy_file']) {
    assert.ok(sessionA.getActiveToolNames().includes(tool), `${tool} must remain available to the real SDK session`);
  }
  const scope = await promptFor(sessionA, 'scope', 'Current working directory: C:/unrelated/Link');
  assert.doesNotMatch(scope, /C:\/unrelated\/Link/);
  assert.match(scope, /Local scratch directory \(not the remote project\):/);
  assert.match(scope, /远程工作目录尚未确认/);
  const hook = await promptFor(sessionA, 'find project');
  assert.match(hook, /Server A/);
  assert.match(hook, /ssh_exec/);
  assert.match(hook, /通过 servers_list 查询用户已添加的所有服务器/);
  assert.match(hook, /通过 ssh_exec 的 serverId 指定目标，无需用户切换会话/);

  // Stop only the inference boundary: the bridge still handles the original
  // user text and sanitizes preview metadata through its production path.
  let sent;
  sessionA.prompt = async text => { sent = text; };
  await bridge.prompt('找一下kingploymer这个项目');
  assert.equal(sent, '找一下kingploymer这个项目');
  await bridge.prompt('当前预览是什么', { preview: {
    kind: 'service', serverId: 'a', port: 8731, title: '广俊螺杆库',
    url: 'http://fixture:password@127.0.0.1:1234/login?token=secret#private', status: 'loaded',
  } });
  const previewHook = await promptFor(sessionA, 'preview');
  assert.match(previewHook, /8731/);
  assert.match(previewHook, /广俊螺杆库/);
  assert.match(previewHook, /http:\/\/127\.0\.0\.1:1234\/login/);
  assert.doesNotMatch(previewHook, /token=secret|fixture:password|#private/);
  assert.equal(sent, '当前预览是什么');

  await bridge.newSession('b');
  const other = await promptFor(bridge.session, 'find project');
  assert.match(other, /Server B/);
  assert.doesNotMatch(other, /Server A|8731/);
  const original = await promptFor(sessionA, 'find project');
  assert.match(original, /Server A/);
  assert.doesNotMatch(original, /Server B/);
  await bridge.newSession('a');
  await bridge.prompt('已关闭预览', { preview: null });
  const cleared = await promptFor(sessionA, 'preview');
  assert.doesNotMatch(cleared, /8731/);
  assert.match(cleared, /"status":"没有打开预览"/);
  isolated.assertOffline();
  console.log('PASS isolated original user text, multi-server instructions and per-session preview system prompts (0 network requests)');
} finally {
  try { await bridge?.dispose(); } finally { isolated.restore(); }
}
