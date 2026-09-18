// Real Electron startup, retry and single-instance checks using only isolated local fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const executableArgument = process.argv.slice(2).find(value => !value.startsWith('--'));
const executable = path.resolve(executableArgument || 'node_modules/electron/dist/electron.exe');
const packaged = Boolean(executableArgument);
const base = path.resolve('tmp/startup-recovery');
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

const serverFiles=['older','newer'].map(name=>path.join(fixture,name+'.jsonl'));
for(const file of serverFiles)fs.writeFileSync(file,'');
const fixtureSettings=JSON.parse(fs.readFileSync(path.join(profile,'halo-settings.json'),'utf8'));
fixtureSettings.servers=[{id:'rename-fixture',name:'Rename test',host:'127.0.0.1',port:1,username:'fixture',auth:'password',secret:''}];
fixtureSettings.serverSessions=Object.fromEntries(serverFiles.map((file,index)=>[file,{file,serverId:'rename-fixture',name:index?'Newer':'Older',modified:index+1}]));
fs.writeFileSync(path.join(profile,'halo-settings.json'),JSON.stringify(fixtureSettings));

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

  await waitFor(async () => (await evaluate('window.halo?.startupState().then(r=>r.data)'))?.ready,'Startup missing');
  await evaluate("document.dispatchEvent(new Event('projectstatechange'))");
  const names=()=>evaluate("[...document.querySelectorAll('#serverList .server-conversation')].map(n=>n.textContent)");
  await waitFor(async()=>(await names()).length===2,'Conversation list missing');
  await evaluate("document.querySelector('[data-tab=skills]').click()");
  assert.deepEqual(await names(),['Newer','Older']);
  await evaluate("document.querySelectorAll('#serverList .server-conversation-rename')[1].click()");
  await waitFor(()=>evaluate("document.querySelector('#conversationRenameModal').classList.contains('show')"),'Rename not opened');
  assert.equal(await evaluate("document.activeElement.id"),'conversationName');
  await evaluate("document.querySelector('#conversationName').value='Cancelled';document.querySelector('#conversationRenameModal [data-close]').click()");
  await new Promise(r=>setTimeout(r,250));
  assert.deepEqual(await names(),['Newer','Older']);
  await evaluate("document.querySelectorAll('#serverList .server-conversation-rename')[1].click();document.querySelector('#conversationName').value='官网 <测试>';document.querySelector('#conversationRenameForm').requestSubmit()");
  await waitFor(async()=>JSON.stringify(await names())===JSON.stringify(['Newer','官网 <测试>']),'Rename not saved');
  assert.equal(await evaluate("document.querySelectorAll('#serverList .server-conversation 测试').length"),0);
  for(const theme of ['light','dark']){
    await evaluate("document.documentElement.dataset.theme="+JSON.stringify(theme)+";document.querySelectorAll('#serverList .server-conversation-rename')[1].click()");
    await new Promise(r=>setTimeout(r,250));
    const shot=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(fixture,'rename-'+theme+'.png'),Buffer.from(shot.result.data,'base64'));
    await evaluate("document.querySelector('#conversationRenameModal [data-close]').click()");
    await new Promise(r=>setTimeout(r,250));
  }
  await evaluate("location.reload();true");
  await waitFor(()=>evaluate("!!window.halo"),'Reload missing');
  await waitFor(async () => (await evaluate('window.halo?.startupState().then(r=>r.data)'))?.ready,'Reload startup missing');
  await evaluate("document.dispatchEvent(new Event('projectstatechange'))");
  await waitFor(async()=>(await names()).length===2,'Reloaded conversation list missing');
  assert.deepEqual(await names(),['Newer','官网 <测试>']);
  await evaluate('setTimeout(()=>window.halo.close(),30);true');
  await waitFor(()=>exitCode!==undefined,'App did not close');
  const saved=JSON.parse(fs.readFileSync(path.join(profile,'halo-settings.json'),'utf8'));
  assert.ok(Object.values(saved.conversationNames).includes('官网 <测试>'));
  console.log(JSON.stringify({ok:true,fixture,checks:['real rename IPC','cancel','literal title rendering','order preserved','reload persistence','light/dark dialog']}));
} finally {
  fs.writeFileSync(path.join(fixture, 'process.log'), output);
  ws?.close();
  if (exitCode === undefined) child.kill();
}

