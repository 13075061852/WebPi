// Isolated Electron text-editing regression; never touches saved accounts or user projects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const executableArgument = process.env.HALO_PACKAGED_EXE;
const executable = path.resolve(executableArgument || 'node_modules/electron/dist/electron.exe');
const packaged = Boolean(executableArgument);
const base = path.join(os.tmpdir(), 'halo-editor-e2e');
fs.mkdirSync(base, { recursive: true });
const fixture = fs.mkdtempSync(path.join(base, 'run-'));
const agent = path.join(fixture, 'agent'), profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace');
for (const dir of [agent, profile, workspace]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: {
  'startup-fixture': { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'offline-fixture', models: [{ id: 'fixture', name: 'Startup fixture', contextWindow: 32000, maxTokens: 2048 }] },
} }));
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'startup-fixture', defaultModel: 'fixture' }));
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, modelKey: 'startup-fixture/fixture', projects: [{ cwd: workspace }] }));
fs.writeFileSync(path.join(workspace, 'readme.txt'), 'Isolated startup verification');
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const system = process.env.SystemRoot || 'C:/Windows';
const env = { SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32/cmd.exe'),
  PATH: [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
  USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  TEMP: fixture, TMP: fixture, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', NO_PROXY: '*', HALO_STARTUP_TRACE: '1' };
const args = [...(packaged ? [] : ['.']), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
const child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', ws, sequence = 0, exitCode;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-30000); });
child.on('error', error => { output += error.message; });
child.on('exit', code => { exitCode = code; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
async function waitFor(fn, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(60); }
  throw Error(`${message}\n${output}`);
}
try {
  const page = await waitFor(async () => {
    if (exitCode !== undefined) throw Error(`Electron exited ${exitCode}: ${output}`);
    try { return (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) })).json()).find(p => p.type === 'page' && p.url.endsWith('index.html')); } catch { return null; }
  }, 'Main page did not load');
  ws = new WebSocket(page.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => { const response = JSON.parse(event.data); pending.get(response.id)?.(response); pending.delete(response.id); });
  const send = async (method, params = {}) => {
    const id = ++sequence;
    let timer;
    try { return await Promise.race([new Promise(resolve => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`CDP timeout: ${method}`)), 8000); })]); }
    finally { clearTimeout(timer); pending.delete(id); }
  };
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(response.result?.exceptionDetails, undefined, JSON.stringify(response.result?.exceptionDetails));
    return response.result?.result?.value;
  };
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(r=>r.data)'))?.ready, 'Startup did not finish');
  await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', {enabled:true});
  await waitFor(() => evaluate('!document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches'), 'Animated test page must be visible with motion enabled');
  await send('Runtime.enable');
  const errors = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Page.enable');
  assert.match(page.url, /index.html$/);
  assert.ok(await evaluate('document.title && document.querySelector("#wsTree") && document.querySelector("#chat")'));
  const code = 'export const title: string = "原始中文";\r\n';
  const filename = path.join(workspace, 'current-scope.ts');
  fs.writeFileSync(filename, code);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# 编辑说明\n');
  fs.writeFileSync(path.join(workspace, 'index.html'), '<h1>Original</h1>');
  fs.writeFileSync(path.join(workspace, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await evaluate('document.documentElement.dataset.theme="light";document.querySelector("#treeRefresh").click()');
  await waitFor(() => evaluate('[...document.querySelectorAll("#wsTree .fname")].some(n=>n.textContent==="current-scope.ts")'), 'Code fixture missing');
  const clickFile = async name => {
    await evaluate(`[...document.querySelectorAll('#wsTree .fname')].find(n=>n.textContent===${JSON.stringify(name)}).closest('.trow').click()`);
    await waitFor(() => evaluate(`document.querySelector('#pvName').textContent===${JSON.stringify(name)} && !document.documentElement.classList.contains('layout-motion') && !!document.querySelector('.file-editor-input, #pvBody iframe, #pvBody .md-view')`), 'File did not load');
  };
  const fill = value => evaluate(`(()=>{const e=document.querySelector('.file-editor-input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);
  const save = async () => {
    await evaluate('document.querySelector(".file-editor-input").focus()');
    await send('Input.dispatchKeyEvent', { type:'keyDown', key:'s', code:'KeyS', windowsVirtualKeyCode:83, modifiers:2 });
    await send('Input.dispatchKeyEvent', { type:'keyUp', key:'s', code:'KeyS', windowsVirtualKeyCode:83, modifiers:2 });
  };
  await clickFile('current-scope.ts');
  assert.equal(await evaluate('!!document.querySelector("#fileEdit, #fileEditSave, #fileEditCancel")'), false, 'No edit/save/cancel buttons');
  assert.equal(await evaluate('document.querySelector(".file-editor-input").value'), code.replace(/\r\n/g, '\n'));
  assert.equal(await evaluate('document.querySelector("#fileEditStatus").textContent'), '', 'No persistent saved label');
  await evaluate('const e=document.querySelector(".file-editor-input");e.focus();e.setSelectionRange(0,0)');
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
  assert.ok((await evaluate('document.querySelector(".file-editor-input").value')).startsWith('  '));
  const changed = 'export const title: string = "已修改中文";\n';
  await fill(changed);
  assert.equal(await evaluate('document.querySelector("#fileEditStatus").textContent'), '未保存');
  await clickFile('README.md');
  await clickFile('current-scope.ts');
  assert.equal(await evaluate('document.querySelector(".file-editor-input").value'), changed);
  assert.equal(fs.readFileSync(filename,'utf8'), code, 'No implicit save');
  await save();
  await waitFor(() => fs.readFileSync(filename,'utf8') === changed.replace(/\n/g,'\r\n'), 'Ctrl+S did not persist CRLF');
  await waitFor(() => evaluate('document.querySelector("#fileEditStatus").textContent===""'), 'Dirty state did not clear');
  await clickFile('README.md'); await clickFile('current-scope.ts');
  assert.equal(await evaluate('document.querySelector(".file-editor-input").value'), changed, 'Reopen reads saved bytes');
  await fill('本地未保存草稿\n');
  fs.writeFileSync(filename, 'external agent edit\r\n');
  await save();
  await waitFor(() => evaluate('document.body.textContent.includes("文件已被外部修改")'), 'Conflict not reported');
  assert.equal(fs.readFileSync(filename,'utf8'), 'external agent edit\r\n');
  assert.equal(await evaluate('document.querySelector(".file-editor-input").value'), '本地未保存草稿\n');
  // Restore the fixture baseline so this test can finish with no unsaved drafts.
  fs.writeFileSync(filename, changed.replace(/\n/g,'\r\n'));
  await save();
  await waitFor(() => evaluate('document.querySelector("#fileEditStatus").textContent===""'), 'Conflict fixture cleanup failed');
  for (const name of ['README.md', 'index.html', 'icon.svg']) {
    await clickFile(name);
    if(name==='README.md') {
      assert.equal(await evaluate('document.querySelector("#pvBody .md-view h1").textContent'), '编辑说明');
      await evaluate('document.querySelector("#pvMode").click()');
      await waitFor(() => evaluate('!!document.querySelector(".file-editor-input")'), 'Markdown source not editable');
      await fill('# 尚未保存的预览\n\n- **重点内容**\n');
      await evaluate('document.querySelector("#pvMode").click()');
      await waitFor(() => evaluate('!!document.querySelector("#pvBody .md-view h1")'), 'Markdown draft preview missing');
      assert.equal(await evaluate('document.querySelector("#pvBody .md-view h1").textContent'), '尚未保存的预览');
      assert.equal(fs.readFileSync(path.join(workspace,name),'utf8'), '# 编辑说明\n', 'Preview does not implicitly save');
      await evaluate('document.querySelector("#pvMode").click()');
      await waitFor(() => evaluate('!!document.querySelector(".file-editor-input")'), 'Markdown draft not restored');
      assert.ok((await evaluate('document.querySelector(".file-editor-input").value')).includes('尚未保存的预览'));
    }
    if(name==='index.html') {
      assert.equal(await evaluate('!!document.querySelector("#pvBody iframe")'),true);
      await evaluate('document.querySelector("#pvMode").click()');
      await waitFor(() => evaluate('!!document.querySelector(".file-editor-input")'), 'HTML source not editable');
    }
    const content = name==='index.html' ? '<h1>Edited</h1>' : name==='icon.svg' ? '<svg xmlns="http://www.w3.org/2000/svg"><title>编辑</title></svg>' : '# 已编辑 Markdown\n';
    await fill(content); await save();
    await waitFor(() => fs.readFileSync(path.join(workspace,name),'utf8')===content, `${name} save failed`);
    await waitFor(() => evaluate('document.querySelector("#fileEditStatus").textContent===""'), 'Save still running');
    if(name==='README.md') {
      await evaluate('document.querySelector("#pvMode").click()');
      await waitFor(() => evaluate('document.querySelector("#pvBody .md-view h1")?.textContent==="已编辑 Markdown"'), 'Saved Markdown did not render');
      const shot=await send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(fixture,'markdown-preview.png'),Buffer.from(shot.result.data,'base64'));
    }
    if(name==='index.html') {
      await evaluate('document.querySelector("#pvMode").click()');
      await waitFor(() => evaluate('!!document.querySelector("#pvBody iframe")'), 'HTML render mode did not restore');
    }
  }
  await clickFile('current-scope.ts');
  await fill('/* 打开文件即可编辑，Ctrl+S 保存 */\nexport const title: string = "编辑代码";\n\nexport function greet(name: string) {\n  return `你好，${name}`;\n}\n');
  await waitFor(() => evaluate('!document.documentElement.classList.contains("layout-motion")'), 'Motion must settle');
  await sleep(150);
  const capture = async name => {
    const shot=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(fixture,name),Buffer.from(shot.result.data,'base64'));
  };
  await capture('editor-light.png');
  await evaluate('document.querySelector("[data-theme-choice=dark]").click()');
  await sleep(250); await capture('editor-dark.png');
  await evaluate('document.querySelector("[data-theme-choice=light]").click();window.resizeTo(1160,800)');
  await sleep(600);
  const geometry = await evaluate(`(()=>{const t=document.querySelector('.file-editor-input').getBoundingClientRect(),c=document.querySelector('#center').getBoundingClientRect();return {textarea:t.width,center:c.width};})()`);
  assert.ok(geometry.textarea>100, JSON.stringify(geometry));
  await capture('editor-compact.png');
  assert.deepEqual(errors, [], 'No renderer runtime exceptions');
  await save();
  await waitFor(() => evaluate('document.querySelector("#fileEditStatus").textContent===""'), 'Final save incomplete');
  console.log(JSON.stringify({ok:true,fixture,geometry,checks:['automatic edit/no action buttons','Tab/Ctrl+S','CRLF','draft switching','external change protection','Markdown/HTML source/SVG','light/dark/compact','no renderer exceptions']}));
  await evaluate('setTimeout(()=>window.halo.close(),30);true');
  await waitFor(()=>exitCode!==undefined,'App did not close');
} finally {
  fs.writeFileSync(path.join(fixture, 'process.log'), output);
  ws?.close();
  if (exitCode === undefined) child.kill();
}
