// Actual Electron UI, preload and trusted IPC. All accounts, repository API
// results and Git mutations below are isolated fixtures; no personal Git state
// or network upload is used. Real Git operations have a separate regression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
assert.ok(fs.existsSync(executable), 'Install source Electron before running repository UI checks');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-git-repositories-'));
const profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace');
const agent = path.join(fixture, 'agent'), cloneParent = path.join(fixture, 'clones'), uploadWorkspace = path.join(fixture, 'new-project');
const reports = path.join(root, 'test', 'results', 'git-repositories');
for (const directory of [profile, workspace, agent, cloneParent, uploadWorkspace, reports]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(uploadWorkspace, 'README.md'), 'New project fixture');
fs.writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true, globalProxy: { mode: 'direct', port: 7890 } }));
fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
fs.writeFileSync(path.join(fixture, 'gitconfig'), ''); fs.writeFileSync(path.join(fixture, 'npmrc'), '');
const controlFile = path.join(fixture, 'control.json'), callsFile = path.join(fixture, 'calls.ndjson');
let control = { cancelPick: true, holdList: false, holdUpload: false, holdTree: false, failUpload: false, projectBusy: false, busyPath: null, untrusted: false, seedSession: null };
const configure = patch => { control = { ...control, ...patch }; fs.writeFileSync(controlFile, JSON.stringify(control)); };
configure({}); fs.writeFileSync(callsFile, '');
const calls = kind => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => !kind || item.kind === kind);
const repository = (fullName, isPrivate = false, canPush = true, description = '') => ({ id: fullName, name: fullName.split('/')[1], fullName, description, private: isPrivate, url: `https://github.com/${fullName}`, defaultBranch: 'main', canPush, localPath: null });
const aliceRepos = [
  repository('alice/private-demo', true, true, '私人项目'),
  repository('team/shared-readonly', false, false, '共享的只读仓库'),
  repository('alice/showcase-web', false, true, '展示网站'),
  repository('alice/a-very-long-repository-name-to-check-picker-clipping-without-covering-the-visibility-tag-or-open-arrow', false, true, '一段很长的仓库介绍，包含设计系统、交互原型、自动化部署和多语言文档，仓库名称及工具栏应该保持在弹窗边界内。'),
  repository('alice/cinematic-video-lab', true, true, '电影级镜头与视频制作实验。长描述只作为搜索与完整名称提示信息，不应撑高工具栏。'),
  repository('alice/creative-image-studio', false, true, '创意图片与海报设计项目'),
  repository('alice/interactive-racing-game', true, true, '竞速小游戏、关卡设计和速度反馈'),
  repository('alice/editorial-brand-site', false, true, '杂志排版、品牌视觉与滚动交互'),
  repository('alice/data-dashboard', true, true, '数据分析仪表板与交互可视化'),
  repository('alice/document-generator', false, true, '文档、演示与报告生成工具'),
  repository('alice/desktop-workspace', true, true, '桌面工作区和文件预览'),
  repository('alice/cloud-preview', false, true, '服务器网页预览性能实验'),
  repository('alice/offline-fixtures', true, true, '隔离的离线测试数据'),
  repository('alice/accessibility-checks', false, true, '键盘导航与无障碍检查'),
  repository('design-team/shared-components', true, true, '设计团队的共享组件、主题、排版与文档。这条较长的团队说明应保持在同一条仓库记录内。'),
  repository('engineering-team/release-automation', false, true, '工程团队的构建、验证与发布流程'),
  repository('community-team/long-term-maintenance-and-compatibility-experiments', false, false, '社区维护的兼容性与长期支持实验')
];
const bobRepos = [repository('bob/bob-only', true), repository('bob/shared-public')];
const bootstrap = path.join(fixture, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const fs=require('node:fs'),path=require('node:path');
const {app,dialog,shell,ipcMain,BrowserWindow}=require('electron');
const read=()=>JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)},'utf8'));
const record=(kind,data={})=>fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({kind,at:Date.now(),...data})+'\\n');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rows={alice:${JSON.stringify(aliceRepos)},bob:${JSON.stringify(bobRepos)}};
let accounts=[],selectedAccount=null;
const locals=new Map([['alice/team/shared-readonly',${JSON.stringify(workspace)}]]),dirty=new Map();
const authState=()=>({available:true,accounts:[...accounts],selectedAccount,busy:false});
const find=(account,fullName)=>{
 const row=rows[account]?.find(item=>item.fullName===fullName);
 if(!row)throw Error('Fixture repository unavailable for this account');
 return {...row,localPath:locals.get(account+'/'+fullName)||null};
};
const snapshot=input=>{
 const row=find(input.account,input.fullName),localPath=input.cwd||row.localPath;
 const files=localPath?(dirty.get(input.account+'/'+input.fullName)||[]):[];
 return {account:input.account,fullName:input.fullName,localPath,branch:localPath?'main':null,ahead:read().pendingOnly?1:0,behind:0,dirty:!!files.length,files,remote:row.url,hasRepository:!!localPath,hasCommits:!!localPath,canPush:row.canPush};
};
const outcome=input=>({repository:find(input.account,input.fullName),status:snapshot(input),cwd:snapshot(input).localPath});
app.on('session-created',created=>created.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true})));
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async()=>{throw Error('External fetch disabled by repository UI regression');},set:()=>{}});
shell.openExternal=async url=>{record('external',{url});};
shell.openPath=async directory=>{record('open-folder',{directory});return '';};
dialog.showOpenDialog=async(_window,options)=>{
 record('directory-picker',{title:options.title,properties:options.properties,defaultPath:options.defaultPath});
 return read().cancelPick?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[${JSON.stringify(cloneParent)}]};
};
const register=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>register(channel,async(event,...args)=>{
 if(channel.startsWith('halo:git-')||channel.startsWith('halo:github-')||channel==='halo:project-add')record('ipc',{channel,args});
 if(channel==='halo:read-tree')while(read().holdTree)await pause(20);
 return handler(event,...args);
});
(async()=>{
 const {GitHubAuth}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/github-auth.mjs')).href)});
 GitHubAuth.prototype.status=async function(){return authState();};
 GitHubAuth.prototype.login=async function(){record('login');accounts=['alice','bob'];selectedAccount='alice';return authState();};
 GitHubAuth.prototype.select=async function(account){if(!accounts.includes(account))throw Error('Fixture account unavailable');record('select',{account});selectedAccount=account;return authState();};
 GitHubAuth.prototype.logout=async function(account){record('logout',{account});accounts=accounts.filter(item=>item!==account);if(selectedAccount===account)selectedAccount=accounts[0]||null;return authState();};
 const {GitRepositories}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/git-repositories.mjs')).href)});
 GitRepositories.prototype.invalidate=function(){};
 GitRepositories.prototype.local=async function(input={}){
  record('local',{input});const repositories=[];
  for(const [key,localPath] of locals){const separator=key.indexOf('/'),account=key.slice(0,separator),fullName=key.slice(separator+1);if(input.account&&input.account!==account)continue;if(!fs.existsSync(localPath))continue;repositories.push({...find(account,fullName),account,localPath});}
  return {account:input.account||'',repositories,total:repositories.length};
 };
 GitRepositories.prototype.list=async function(input={}){
  const account=input.account||selectedAccount;record('list-start',{account});
  if(account==='alice')while(read().holdList)await pause(20);
  const repositories=(rows[account]||[]).map(row=>({...row,localPath:locals.get(account+'/'+row.fullName)||null}));
  record('list-end',{account});return {account,repositories,total:repositories.length};
 };
 GitRepositories.prototype.status=async function(input){record('status',{input});return snapshot(input);};
 GitRepositories.prototype.clone=async function(input){
  record('clone',{input});const row=find(input.account,input.fullName),cwd=path.join(input.parent,row.name);
  fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'README.md'),'Offline clone fixture');fs.writeFileSync(path.join(cwd,'notes.txt'),'Unselected file');
  locals.set(input.account+'/'+input.fullName,cwd);dirty.set(input.account+'/'+input.fullName,[{path:'README.md',status:' M',staged:false},{path:'notes.txt',status:'??',staged:false}]);
  return outcome(input);
 };
 GitRepositories.prototype.bind=async function(input){record('bind',{input});locals.set(input.account+'/'+input.fullName,input.cwd);dirty.set(input.account+'/'+input.fullName,[{path:'README.md',status:' M',staged:false}]);return outcome(input);};
 GitRepositories.prototype.filePreview=async function(input){record('preview-start',{input});while(read().holdPreview)await pause(20);record('preview-end',{input});return {text:read().emptyPreview?'':'diff '+input.file+'\\n+offline changed content'};};
 GitRepositories.prototype.commitContext=async function(input){record('commit-context',{input});return {repository:input.fullName,branch:'main',files:input.files.map(file=>({path:file,status:' M',diff:'selected change in '+file}))};};
 GitRepositories.prototype.update=async function(input){record('update',{input});await pause(250);const file=path.join(snapshot(input).localPath,'remote-update.txt'),upToDate=fs.existsSync(file);if(!upToDate)fs.writeFileSync(file,'Updated fixture');dirty.set(input.account+'/'+input.fullName,[]);return {...outcome(input),upToDate};};
 GitRepositories.prototype.upload=async function(input){
  record('upload',{input});while(read().holdUpload)await pause(20);if(read().failUpload)throw Error('Fixture upload failed, retry allowed');
  const remaining=snapshot(input).files.filter(file=>!input.files.includes(file.path));dirty.set(input.account+'/'+input.fullName,remaining);return outcome(input);
 };
 GitRepositories.prototype.create=async function(input){record('create',{input});const row=(${repository.toString()})(input.account+'/'+input.name,input.private,true,input.description);rows[input.account].unshift(row);return {repository:row,status:null,cwd:null};};
 const {PiBridge}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/pi-bridge.mjs')).href)});
 const start=PiBridge.prototype.start;let bridge;
 PiBridge.prototype.start=async function(...args){
  bridge=this;const result=await start.apply(this,args);
  this.modelRuntime.completeSimple=async(model,context,options)=>{
   record('commit-ai',{model:model.id,context,hasTools:!!context.tools});
   while(read().holdAI&&!options.signal.aborted)await pause(20);
   if(read().failAI)return {stopReason:'error',errorMessage:'Fixture AI unavailable'};
   return {stopReason:'stop',content:[{type:'text',text:'更新 '+JSON.parse(context.messages[0].content[0].text).files.map(file=>file.path).join('、')+' 的改动'}]};
  };return result;
 };
 PiBridge.prototype.isProjectBusy=function(cwd){const c=read();return c.projectBusy&&(!c.busyPath||path.resolve(cwd).toLowerCase()===path.resolve(c.busyPath).toLowerCase());};
 await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/main/main.mjs')).href)});
 let testingUntrusted=false;const seeded=new Set();
 const timer=setInterval(async()=>{
  const seed=read().seedSession;
  if(seed&&bridge?.session?.sessionId===seed.id&&!seeded.has(seed.id)){
   seeded.add(seed.id);const session=bridge.session;
   const messages=[{role:'user',content:[{type:'text',text:seed.text}],timestamp:Date.now()},{role:'assistant',content:[{type:'text',text:'Offline reply: '+seed.text}],provider:'fixture',model:'a',stopReason:'stop',timestamp:Date.now()+1}];
   session.emit({type:'agent_start'});
   for(const message of messages){session.sessionManager.appendMessage(message);session.agent.state.messages.push(message);session.emit({type:'message_start',message});session.emit({type:'message_end',message});}
   session.emit({type:'agent_end',messages});session.emit({type:'agent_settled'});record('session-seeded',{id:seed.id,file:session.sessionFile,text:seed.text});
  }
  if(!read().untrusted||testingUntrusted||!app.isReady())return;
  testingUntrusted=true;
  const foreign=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(path.join(root, 'src/preload/preload.cjs'))},contextIsolation:true,nodeIntegration:false,sandbox:true}});
  try{
   await foreign.loadURL('data:text/html,<title>Untrusted fixture</title>');
   const reply=await foreign.webContents.executeJavaScript('window.halo.gitRepositories({account:"alice"})');record('untrusted-result',{reply});
  }catch(error){record('untrusted-error',{error:error.message});}finally{foreign.destroy();clearInterval(timer);}
 },30);
 app.on('before-quit',()=>clearInterval(timer));
})().catch(error=>{console.error(error);app.exit(1);});
`);

const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const cdpPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE|PROXY|^GIT_|^GH_|^GCM_|^SSH_|^NODE_OPTIONS$)/i.test(key)));
Object.assign(env, { USERPROFILE: fixture, HOME: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
  XDG_CONFIG_HOME: path.join(fixture, 'config'), XDG_CACHE_HOME: path.join(fixture, 'cache'), GH_CONFIG_DIR: path.join(fixture, 'gh'),
  GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GCM_INTERACTIVE: 'never',
  NPM_CONFIG_USERCONFIG: path.join(fixture, 'npmrc'), TEMP: fixture, TMP: fixture, TMPDIR: fixture, NO_PROXY: '*',
  PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_HALO_PI_PATH: path.join(root, 'test/fixtures/pi-sdk.js') });
const child = spawn(executable, [bootstrap, `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', exitCode, ws, sequence = 0;
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-20000); });
child.on('exit', code => { exitCode = code; });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const pending = new Map(), exceptions = [], passed = [], themes = [], pickerLayouts = [];
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check(); if (result) return result;
    if (exitCode !== undefined) throw Error(`Electron exited ${exitCode}: ${output}`);
    await sleep(30);
  }
  const state = ws ? await evaluate(`({body:document.body.innerText.slice(-4500),account:document.querySelector('#gitAccount')?.textContent,dialog:document.querySelector('#gitRepositoryDialog')?.outerHTML.slice(0,2500)})`).catch(() => null) : null;
  throw Error(`Timed out: ${label}\n${JSON.stringify(state)}\n${JSON.stringify(calls().slice(-20))}\n${output}`);
}
async function command(method, params = {}) {
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result;
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails)); return response.result?.value;
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const change = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
const openRepo = fullName => click(`#gitRemoteRepositoryList .git-repo-row[data-repository="${fullName}"]`);
const rows = () => evaluate(`[...document.querySelectorAll('#gitRemoteRepositoryList .git-repo-row')].map(row=>({fullName:row.dataset.repository,text:row.textContent}))`);
const localRows = () => evaluate(`[...document.querySelectorAll('#gitRepositoryList .project-group[data-repository]')].map(row=>({fullName:row.dataset.repository,text:row.textContent}))`);
const localSelector = (fullName, selector) => `#gitRepositoryList .project-group[data-repository="${fullName}"] ${selector}`;
const dialogText = () => evaluate(`document.querySelector('#gitRepositoryDialog').textContent`);
const pass = label => { passed.push(label); console.log('PASS', label); };
const dialogVisible = () => evaluate(`(()=>{const e=document.querySelector('#gitRepositoryDialog');return !!e&&!e.hidden&&e.getBoundingClientRect().height>0})()`);
async function settleAnimations(label) {
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await until(() => evaluate(`document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).every(animation=>['finished','idle'].includes(animation.playState))`), `${label} finite transitions settle`);
}
async function applyTheme(theme) {
  await click(`[data-theme-choice="${theme}"]`);
  await until(() => evaluate(`(document.documentElement.dataset.surface||document.documentElement.dataset.theme)===${JSON.stringify(theme)}`), `${theme} applied`);
  await settleAnimations(theme);
}
async function pickerGeometry() {
  return evaluate(`(()=>{
    const get=selector=>document.querySelector(selector),rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const list=get('#gitRemoteRepositoryList'),panel=get('#gitRepositoryDialog .modal-panel'),body=get('#gitRepositoryDialog .git-dialog-body');
    return {theme:document.documentElement.dataset.surface||document.documentElement.dataset.theme,viewport:{width:innerWidth,height:innerHeight},panel:{...rect(panel),client:panel.clientWidth,scroll:panel.scrollWidth,scrollTop:panel.scrollTop},body:{scrollTop:body.scrollTop},pageScrollTop:document.documentElement.scrollTop,
      toolbar:rect(get('.git-picker-toolbar')),search:rect(get('#gitSearch')),extraControls:!!get('#gitLogin,#gitRefresh'),statusHidden:get('#gitRemoteRepositoryMessage').hidden,account:{...rect(get('#gitAccount')),text:get('#gitAccount').textContent,tabIndex:get('#gitAccount').tabIndex,interactive:get('#gitAccount').matches('select,input,button,[role="button"],[role="combobox"]')||!!get('#gitAccount').querySelector('select,input,button')},
      heading:rect(get('#gitRepoTitle')),controls:['#gitSearch','#gitRemoteCreate'].map(selector=>({selector,...rect(get(selector))})),
      list:{...rect(list),client:list.clientWidth,scroll:list.scrollWidth,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,scrollTop:list.scrollTop},
      rows:[...list.querySelectorAll('.git-repo-row')].map(row=>({fullName:row.dataset.repository,...rect(row),owner:row.querySelector('.git-repo-owner')?.textContent||''}))};
  })()`);
}
async function checkPickerLayout(label, screenshotName) {
  await evaluate(`document.querySelector('#gitRemoteRepositoryList').scrollTop=0`);
  await settleAnimations(label);
  const before = await pickerGeometry();
  assert.equal(before.rows.length, aliceRepos.length, `${label}: all fixture repositories render`);
  assert.ok(before.panel.left >= 0 && before.panel.top >= 0 && before.panel.right <= before.viewport.width + 1 && before.panel.bottom <= before.viewport.height + 1, `${label}: dialog stays in visible viewport`);
  assert.ok(before.panel.scroll <= before.panel.client + 1 && before.list.scroll <= before.list.client + 1, `${label}: long names do not create horizontal overflow`);
  assert.ok(before.account.width <= 240 && before.account.width < before.toolbar.width / 2, `${label}: account information remains bounded`);
  assert.equal(before.account.text.trim(), 'alice'); assert.equal(before.account.interactive, false); assert.equal(before.account.tabIndex, -1, `${label}: account information is static`);
  assert.ok(before.account.bottom < before.toolbar.top && before.account.left >= before.heading.right, `${label}: account appears beside title above toolbar`);
  assert.ok(Math.abs((before.account.top + before.account.bottom) / 2 - (before.heading.top + before.heading.bottom) / 2) <= 1, 'Account and title align vertically');
  for (const item of [...before.controls, before.account]) assert.ok(item.left >= before.panel.left && item.right <= before.panel.right + 1 && item.top >= before.panel.top && item.bottom <= before.panel.bottom + 1, `${label}: picker controls remain visible`);
  for (const item of before.controls) {
    assert.ok(Math.abs(item.height - 32) <= 0.5, `${label}: ${item.selector} has the common 32px height`);
    assert.ok(Math.abs(item.top - before.controls[0].top) <= 1 && Math.abs(item.bottom - before.controls[0].bottom) <= 1, `${label}: account actions align vertically with equal heights`);
  }
  assert.equal(before.extraControls, false, 'Removed login and refresh controls are absent');
  assert.equal(before.statusHidden, true, 'No repository count occupies the toolbar');
  assert.ok(before.list.scrollHeight > before.list.clientHeight + 100, `${label}: full list has real scrollable content`);
  for (const row of before.rows) {
    assert.ok(row.left >= before.list.left - 1 && row.right <= before.list.right + 1, `${label}: repository rows stay inside list width`);
    assert.equal(row.owner, row.fullName.startsWith('alice/') ? '' : row.fullName.split('/')[0], `${label}: only team owners use a secondary owner label`);
  }
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reports, screenshotName), Buffer.from(screenshot.data, 'base64'));
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: (before.list.left + before.list.right) / 2, y: (before.list.top + before.list.bottom) / 2, deltaX: 0, deltaY: 450 });
  await until(() => evaluate(`document.querySelector('#gitRemoteRepositoryList').scrollTop>0`), `${label}: real wheel scrolls repository list`);
  await sleep(120);
  const after = await pickerGeometry();
  for (const key of ['toolbar', 'search', 'account']) for (const edge of ['top', 'bottom', 'left', 'right']) assert.ok(Math.abs(before[key][edge] - after[key][edge]) <= 1, `${label}: ${key} remains fixed while list scrolls`);
  assert.equal(after.panel.scrollTop, before.panel.scrollTop); assert.equal(after.body.scrollTop, before.body.scrollTop); assert.equal(after.pageScrollTop, before.pageScrollTop);
  pickerLayouts.push({ label, before, after });
  await evaluate(`document.querySelector('#gitRemoteRepositoryList').scrollTop=0`);
}
async function closeDialog() { await click('#gitRepoClose'); await until(async () => !(await dialogVisible()), 'repository dialog closes'); }
async function checkBottomActions() {
  assert.equal(await evaluate(`(()=>{
    const get=s=>document.querySelector(s),rect=s=>get(s).getBoundingClientRect();
    const selectors=['#gitRepoOpen','#gitRepoUpdate','#gitRepoRefresh','#gitRepoUpload'],buttons=selectors.map(rect),area=rect('#gitPendingFiles'),commit=get('#gitCommitMessage')?.getBoundingClientRect(),panel=rect('.git-repository-panel');
    return selectors.every(s=>!!get(s).closest('.git-bottom-actions'))&&buttons.every(b=>Math.abs(b.top-buttons[0].top)<1&&Math.abs(b.height-buttons[0].height)<1&&b.top>=area.bottom&&(!commit||b.top>commit.bottom)&&b.left>=panel.left&&b.right<=panel.right)&&get('.git-commit-footer')===get('.git-dialog-body').lastElementChild;
  })()`), true, 'All repository actions share the bottom row below content and commit message');
}
async function browse() {
  if (await dialogVisible()) {
    if (await evaluate(`document.querySelector('#gitRepoPickerBack')?.hidden===false`)) await click('#gitRepoPickerBack');
  } else await click('#gitBrowse');
  await until(() => evaluate(`!!document.querySelector('#gitRemoteRepositoryList')`), 'remote repository picker');
}
async function manage(fullName) {
  if (await dialogVisible()) await closeDialog();
  if ((await localRows()).some(row => row.fullName === fullName)) {
    await click(localSelector(fullName, 'details.server-group-menu summary'));
    await click(localSelector(fullName, '.git-repository-manage'));
  } else {
    await browse(); await until(async () => (await rows()).some(row => row.fullName === fullName), `${fullName} in remote picker`); await openRepo(fullName);
  }
  await until(async () => (await dialogVisible()) && (await dialogText()).includes(fullName) && await evaluate(`!!document.querySelector('#gitRepoClone')||!!document.querySelector('#gitRepoUpload')`), `${fullName} manage view`);
}

try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find(item => item.type === 'page' && item.url.endsWith('index.html')); } catch {} }, 'main renderer');
  ws = new WebSocket(target.webSocketDebuggerUrl); await once(ws, 'open');
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data), item = pending.get(response.id);
    if (item) { clearTimeout(item.timer); pending.delete(response.id); item.resolve(response); }
    if (response.method === 'Runtime.exceptionThrown') exceptions.push(response.params.exceptionDetails);
  });
  await command('Runtime.enable'); await command('Page.enable'); await command('Page.bringToFront');
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until(() => evaluate('!!window.__haloDispatch && window.halo.startupState().then(r=>r.data.ready)'), 'isolated startup');
  await until(() => evaluate(`!!document.querySelector('.nav-item[data-tab="git"]')`), 'Git navigation exists');
  await click('.nav-item[data-tab="git"]');
  await until(async () => (await localRows()).length === 1, 'saved local repository without login');
  assert.deepEqual((await localRows()).map(row => row.fullName), ['team/shared-readonly']);
  assert.equal(calls('login').length, 0); assert.equal(calls('list-start').length, 0);
  assert.equal(await evaluate(`!!document.querySelector('#gitAccount')||!!document.querySelector('#gitSearch')`), false);
  pass('Repository sidebar shows saved local projects without login, remote account controls or REST loading');
  await until(() => evaluate(`getComputedStyle(document.querySelector('#sidebar')).opacity==='1'`), 'sidebar entrance animation settles');

  for (const theme of ['light', 'dark', 'glass']) {
    await applyTheme(theme);
    const bounds = await evaluate(`(()=>{const pane=document.querySelector('.side-section[data-pane="git"]'),side=document.querySelector('#sidebar'),nav=document.querySelector('#sideNav'),s=side.getBoundingClientRect(),p=pane.getBoundingClientRect(),style=getComputedStyle(pane),b=document.querySelector('#gitBrowse').getBoundingClientRect(),c=document.querySelector('#gitCreate').getBoundingClientRect();return {theme:document.documentElement.dataset.surface||document.documentElement.dataset.theme,pane:{client:pane.clientWidth,scroll:pane.scrollWidth,contentLeft:p.left+parseFloat(style.paddingLeft),contentRight:p.right-parseFloat(style.paddingRight)},browse:{left:b.left,right:b.right,height:b.height,top:b.top},create:{left:c.left,right:c.right,height:c.height,top:c.top},nav:{client:nav.clientWidth,scroll:nav.scrollWidth},buttons:[...nav.querySelectorAll('.nav-item')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,disabled:b.disabled}}),side:{left:s.left,right:s.right},rows:[...pane.querySelectorAll('.project-group')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right}})}})()`);
    assert.equal(bounds.buttons.length, 3); assert.ok(bounds.nav.scroll <= bounds.nav.client + 1); assert.ok(bounds.pane.scroll <= bounds.pane.client + 1);
    for (const item of [...bounds.buttons, ...bounds.rows]) assert.ok(item.left >= bounds.side.left - 1 && item.right <= bounds.side.right + 1, `${theme}: sidebar contains controls`);
    assert.equal(bounds.browse.height, bounds.create.height, `${theme}: clone and create share button height`);
    assert.ok(Math.abs(bounds.browse.top - bounds.create.top) <= 1 && bounds.browse.right <= bounds.create.left, `${theme}: clone sits beside create on the same row`);
    themes.push(bounds); const screenshot = await command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(reports, `${theme}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  pass('Three navigation tabs and local project groups fit in light, dark and glass themes');
  await browse(); await until(() => evaluate(`document.querySelector('#gitAccount')?.textContent==='未登录'`), 'logged-out picker');
  assert.equal((await rows()).length, 0);
  assert.equal(await evaluate(`!!document.querySelector('#gitLogin,#gitRefresh')`), false);
  await closeDialog(); await evaluate('window.halo.githubLogin()'); await browse();
  await until(async () => (await rows()).length === aliceRepos.length, 'all accessible Alice repositories in picker');
  assert.equal(calls('login').length, 1); assert.equal(await evaluate(`document.querySelector('#gitAccount').textContent.trim()`), 'alice');
  assert.ok((await rows()).find(row => row.fullName === 'alice/private-demo')?.text.includes('私有'));
  assert.ok((await rows()).some(row => row.fullName === 'team/shared-readonly'));
  assert.deepEqual((await localRows()).map(row => row.fullName), ['team/shared-readonly']);
  pass('Remote picker loads private and shared repositories without adding uncloned entries to the sidebar');
  for (const theme of ['light', 'dark', 'glass']) {
    await applyTheme(theme); await checkPickerLayout(theme, `picker-${theme}.png`);
  }
  fs.copyFileSync(path.join(reports, 'picker-glass.png'), path.join(reports, 'remote-picker.png'));
  pass('Seventeen repositories fit in all three themes; team labels stay concise and only the list scrolls');
  await command('Emulation.setDeviceMetricsOverride', { width: 760, height: 700, deviceScaleFactor: 1, mobile: false });
  await checkPickerLayout('760x700', 'picker-narrow.png');
  pass('Narrow picker keeps static account information, equal-height toolbar and search visible without overflow');
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await settleAnimations('restored full window');
  await change('#gitSearch', 'showcase-web'); assert.deepEqual((await rows()).map(row => row.fullName), ['alice/showcase-web']);
  await change('#gitSearch', ''); await until(async () => (await rows()).length === aliceRepos.length, 'search reset'); pass('Repository search filters and restores the complete list');

  await manage('team/shared-readonly');
  assert.equal(await evaluate(`document.querySelector('#gitRepoUpload').disabled`), true);
  const readonlyUploadCount = calls('upload').length; await click('#gitRepoUpload');
  assert.equal(calls('upload').length, readonlyUploadCount); assert.equal(await evaluate(`document.querySelector('#gitRepositoryDialog').dataset.view`), 'manage');
  pass('Readonly repository management disables upload before submission'); await closeDialog();

  await browse(); await until(async () => (await rows()).length === aliceRepos.length, 'Alice picker ready');
  configure({ holdList: true }); const listCount = calls('list-start').length;
  await closeDialog(); await browse(); await until(() => calls('list-start').length > listCount, 'delayed Alice refresh on reopen');
  assert.equal((await evaluate(`window.halo.githubSelect('bob')`)).ok, true);
  await closeDialog(); await browse();
  await until(async () => (await rows()).length === bobRepos.length && (await rows()).every(row => row.fullName.startsWith('bob/')), 'externally selected Bob account results after reopening');
  assert.equal(await evaluate(`document.querySelector('#gitAccount').textContent.trim()`), 'bob');
  configure({ holdList: false }); await until(() => calls('list-end').filter(item => item.account === 'alice').length === calls('list-start').filter(item => item.account === 'alice').length, 'old account refresh completed');
  await evaluate('window.halo.githubStatus()'); assert.ok((await rows()).every(row => row.fullName.startsWith('bob/'))); pass('Late refresh from the previous account cannot overwrite selected account results');
  assert.equal((await evaluate(`window.halo.githubSelect('alice')`)).ok, true);
  await closeDialog(); await browse(); await until(async () => (await rows()).length === aliceRepos.length, 'Alice restored after external account change and reopen');

  const projectsBefore = (await evaluate('window.halo.projectsList()')).data;
  await manage('alice/private-demo'); await click('#gitCloneBrowse'); await until(() => calls('directory-picker').length === 1, 'clone directory cancellation');
  await until(() => evaluate(`!document.querySelector('#gitRepoClone')?.disabled`), 'clone controls restored after cancellation');
  assert.equal(calls('clone').length, 0); assert.deepEqual(fs.readdirSync(cloneParent), []);
  assert.ok(path.isAbsolute(calls('directory-picker')[0].defaultPath));
  assert.notEqual(calls('directory-picker')[0].defaultPath, workspace, 'Default clone directory is independent of the current project');
  assert.deepEqual((await evaluate('window.halo.projectsList()')).data, projectsBefore);
  assert.deepEqual((await localRows()).map(row => row.fullName), ['team/shared-readonly']); pass('Cancelling native clone destination creates no directory, project or sidebar entry');
  configure({ cancelPick: false }); await click('#gitCloneBrowse');
  await until(() => evaluate(`document.querySelector('#gitCloneDirectory')?.value`).then(value => value === cloneParent), 'browsed directory visible before clone');
  await until(() => evaluate(`!document.querySelector('#gitRepoClone')?.disabled`), 'directory selection complete');
  await click('#gitRepoClone');
  const clonedPath = path.join(cloneParent, 'private-demo');
  await until(() => evaluate('window.halo.getState().then(r=>r.data.cwd)').then(cwd => path.resolve(cwd) === path.resolve(clonedPath)), 'clone enters registered project');
  assert.equal(calls('clone').length, 1); assert.equal(calls('ipc').filter(item => item.channel === 'halo:project-add').length, 1);
  assert.ok(fs.existsSync(path.join(clonedPath, 'README.md')));
  await until(async () => (await localRows()).some(row => row.fullName === 'alice/private-demo'), 'cloned repository appears in local sidebar');
  assert.equal((await localRows()).length, 2); pass('Successful clone opens the registered project and adds exactly one local sidebar entry');
  if (await dialogVisible()) await closeDialog();
  await click('.nav-item[data-tab="git"]');
  const remoteBeforeLocal = calls('list-start').length, statusBeforeLocal = calls('status').length;
  await click(localSelector('team/shared-readonly', '.project-toggle'));
  await until(() => evaluate('window.halo.getState().then(r=>r.data.cwd)').then(cwd => path.resolve(cwd) === path.resolve(workspace)), 'local readonly name enters its project');
  await click(localSelector('alice/private-demo', '.project-toggle'));
  await until(() => evaluate('window.halo.getState().then(r=>r.data.cwd)').then(cwd => path.resolve(cwd) === path.resolve(clonedPath)), 'local clone name enters its project');
  assert.equal(await dialogVisible(), false); assert.equal(calls('list-start').length, remoteBeforeLocal); assert.equal(calls('status').length, statusBeforeLocal);
  pass('Clicking a local repository name opens its cwd directly without management or remote requests');
  const repoToggle = localSelector('alice/private-demo', '.project-toggle');
  const repoFold = localSelector('alice/private-demo', '.conversation-fold');
  const repoChildren = localSelector('alice/private-demo', '.project-conversations');
  const initialExpanded = await evaluate(`document.querySelector(${JSON.stringify(repoToggle)}).getAttribute('aria-expanded')`);
  for (const expected of [initialExpanded === 'true' ? 'false' : 'true', initialExpanded]) {
    await click(repoToggle);
    await until(() => evaluate(`document.querySelector(${JSON.stringify(repoToggle)})?.getAttribute('aria-expanded')===${JSON.stringify(expected)} && document.querySelector(${JSON.stringify(repoFold)})?.getAttribute('aria-expanded')===${JSON.stringify(expected)} && document.querySelector(${JSON.stringify(repoChildren)})?.hidden===${expected !== 'true'}`), 'repository name toggles children and arrow together');
  }
  pass('Repository name expands and collapses its conversation list with matching arrow state');

  await manage('alice/private-demo');
  const pendingText = await evaluate(`document.querySelector('#gitPendingFiles').textContent`);
  assert.ok(pendingText.includes('README.md') && pendingText.includes('notes.txt'));
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#gitUploadFiles input')].map(input=>input.checked)`), [true,true], 'Automatic first preview preserves default checkboxes');
  await click('#gitPendingFiles .git-pending-entry:last-child .git-pending-row');
  await until(()=>evaluate(`document.querySelector('.git-pending-content').textContent.includes('notes.txt')`), 'selected file content appears on right');
  assert.equal(await evaluate(`document.querySelector('#gitUploadFiles .git-pending-entry:last-child input').checked`),false,'Clicking the filename toggles its checkbox');
  const previewsBeforeToggle = calls('preview-start').length;
  await click('#gitUploadFiles .git-pending-entry:last-child .git-pending-row');
  assert.equal(await evaluate(`document.querySelector('#gitUploadFiles .git-pending-entry:last-child input').checked`),true);
  await click('#gitUploadFiles .git-pending-entry:first-child .git-pending-row');
  await until(()=>evaluate(`document.querySelector('.git-pending-content').textContent.includes('README.md')`),'cached first file renders');
  await click('#gitUploadFiles .git-pending-entry:last-child input');
  assert.equal(await evaluate(`document.querySelector('#gitUploadFiles .git-pending-entry:last-child input').checked`),false,'Checkbox clicks toggle exactly once');
  assert.equal(await evaluate(`document.querySelector('.git-pending-content').textContent.includes('notes.txt')&&!document.querySelector('.git-pending-content.is-loading')`),true);
  assert.equal(calls('preview-start').length,previewsBeforeToggle,'Cached selection and checkbox toggles do not read again');
  configure({holdPreview:true}); const previewsBeforeRefresh=calls('preview-start').length;
  await click('#gitRepoRefresh');
  await until(()=>calls('preview-start').length===previewsBeforeRefresh+1,'explicit refresh discards old preview cache');
  await click('#gitUploadFiles .git-pending-entry:last-child .git-pending-row');
  await until(()=>calls('preview-start').length===previewsBeforeRefresh+2,'second file starts one pending request');
  await click('#gitUploadFiles .git-pending-entry:first-child .git-pending-row');
  await until(()=>evaluate(`!!document.querySelector('.git-pending-content.is-loading')`),'slow reads show centered loading');
  assert.equal(calls('preview-start').length,previewsBeforeRefresh+2,'Returning to a pending preview reuses the request');
  configure({holdPreview:false});
  await until(()=>evaluate(`document.querySelector('.git-pending-content').textContent.includes('README.md')&&!document.querySelector('.git-pending-content.is-loading')`),'latest selected file wins late preview results');
  await click('#gitUploadFiles .git-pending-entry:last-child .git-pending-row');
  await until(()=>evaluate(`document.querySelector('.git-pending-content').textContent.includes('notes.txt')`),'cached second file ready');
  pass('Filename and checkbox clicks stay linked; cached and in-flight previews are reused until refresh');
  assert.equal(await evaluate(`(()=>{const a=document.querySelector('.git-file-column').getBoundingClientRect(),b=document.querySelector('.git-pending-detail').getBoundingClientRect();return a.right<b.left&&Math.abs(a.top-b.top)<1})()`),true);
  const pendingScreenshot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(reports,'pending-split.png'),Buffer.from(pendingScreenshot.data,'base64'));
  for (const theme of ['light', 'dark', 'glass']) {
    await applyTheme(theme); await settleAnimations('repository detail ' + theme);
    await checkBottomActions();
    assert.equal(await evaluate(`(()=>{const a=document.querySelector('.git-file-header'),b=document.querySelector('.git-pending-detail-title'),x=a.getBoundingClientRect(),y=b.getBoundingClientRect(),r=document.querySelector('.git-pending-entry').getBoundingClientRect();return a.textContent.includes('文件')&&a.textContent.includes('状态')&&Math.abs(x.top-y.top)<1&&Math.abs(x.bottom-y.bottom)<1&&r.top>=x.bottom})()`),true,'Both file and preview headers align above the first row');
    const shot = await command('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(path.join(reports, 'detail-' + theme + '.png'), Buffer.from(shot.data,'base64'));
  }
  configure({ emptyPreview: true }); await click('#gitRepoRefresh');
  await until(()=>evaluate(`!!document.querySelector('#gitUploadFiles')`),'file list refreshed for changed content');
  await click('#gitPendingFiles .git-pending-entry:last-child .git-pending-row');
  await until(()=>evaluate(`!!document.querySelector('.git-pending-content.is-empty')`),'empty file uses centered placeholder');
  const emptyPreviewShot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(reports,'empty-file-preview.png'),Buffer.from(emptyPreviewShot.data,'base64'));
  configure({ emptyPreview: false });
  await command('Emulation.setDeviceMetricsOverride', { width: 760, height: 700, deviceScaleFactor: 1, mobile: false });
  await settleAnimations('narrow file review'); await checkBottomActions();
  assert.equal(await evaluate(`(()=>{const p=document.querySelector('.git-pending-split');return p.scrollWidth<=p.clientWidth+1})()`),true,'File review fits narrow window');
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await closeDialog();
  const firstSession = (await evaluate('window.halo.getState()')).data;
  configure({ seedSession: { id: firstSession.sessionId, text: 'Repository conversation one' } });
  await until(() => calls('session-seeded').some(item => item.id === firstSession.sessionId), 'first repository session persisted');
  await until(() => evaluate(`document.querySelector(${JSON.stringify(localSelector('alice/private-demo', '.project-conversation-name'))})?.textContent.includes('Repository conversation one')`), 'persisted local conversation in sidebar');
  await click(localSelector('alice/private-demo', '.project-new'));
  const secondSession = await until(async () => {
    const state = (await evaluate('window.halo.getState()')).data;
    return state.sessionId !== firstSession.sessionId && path.resolve(state.cwd) === path.resolve(clonedPath) ? state : null;
  }, 'new repository conversation created and focused');
  configure({ seedSession: { id: secondSession.sessionId, text: 'Repository conversation two' } });
  await until(() => calls('session-seeded').some(item => item.id === secondSession.sessionId), 'second repository session persisted');
  await until(() => evaluate(`document.querySelectorAll(${JSON.stringify(localSelector('alice/private-demo', '.project-conversation-name'))}).length===2`), 'two repository conversations in sidebar');
  await evaluate(`[...document.querySelectorAll(${JSON.stringify(localSelector('alice/private-demo', '.project-conversation-name'))})].find(button=>button.textContent.includes('Repository conversation one')).click()`);
  await until(() => evaluate('window.halo.getState().then(r=>r.data.sessionId)').then(id => id === firstSession.sessionId), 'first repository conversation restored');
  await until(() => evaluate(`document.querySelector('#messages').textContent.includes('Offline reply: Repository conversation one')&&!document.querySelector('#messages').textContent.includes('Repository conversation two')`), 'first conversation history isolated');
  await evaluate(`[...document.querySelectorAll(${JSON.stringify(localSelector('alice/private-demo', '.project-conversation-name'))})].find(button=>button.textContent.includes('Repository conversation two')).click()`);
  await until(() => evaluate('window.halo.getState().then(r=>r.data.sessionId)').then(id => id === secondSession.sessionId), 'second repository conversation restored');
  await until(() => evaluate(`document.querySelector('#messages').textContent.includes('Offline reply: Repository conversation two')&&!document.querySelector('#messages').textContent.includes('Repository conversation one')`), 'second conversation history isolated');
  pass('Local repository new-conversation button uses real session creation, history switching and isolated restore');
  await settleAnimations('restored repository conversation');
  const localScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reports, 'local-conversations.png'), Buffer.from(localScreenshot.data, 'base64'));

  await manage('alice/private-demo');
  await until(() => evaluate(`document.querySelectorAll('#gitUploadFiles input[type="checkbox"]').length===2`), 'upload file review');
  assert.equal(calls('upload').length, 0); assert.match(await dialogText(), /alice\/private-demo/);
  assert.match(await dialogText(), /main/); assert.equal(await evaluate(`document.querySelector('#gitRepoUpload').textContent.trim()`), '推送');
  assert.equal(await evaluate(`document.querySelector('#gitRepositoryDialog').dataset.view`), 'manage');
  assert.equal(await evaluate(`!!document.querySelector('.git-pending-detail') && !document.querySelector('#gitUploadBack')`), true);
  await evaluate(`for(const box of document.querySelectorAll('#gitUploadFiles input')){box.checked=box.value==='README.md';box.dispatchEvent(new Event('change',{bubbles:true}))}`);
  configure({ holdAI: true, failAI: true }); await click('#gitRepoUpload');
  await until(() => calls('commit-ai').length === 1, 'empty description starts AI analysis');
  assert.equal(await evaluate(`document.querySelector('#gitRepoUpload').textContent`), 'AI 分析中…');
  assert.equal(await evaluate(`document.querySelector('#gitRepoUpload').getAttribute('aria-busy')`), 'true');
  assert.equal(await evaluate(`document.querySelector('#gitRepoMessage').textContent`), '');
  assert.equal(calls('upload').length, 0); await click('#gitRepoUpload'); assert.equal(calls('commit-ai').length, 1);
  assert.deepEqual(calls('commit-context')[0].input.files, ['README.md']);
  assert.equal(calls('commit-ai')[0].hasTools, false);
  configure({ holdAI: false });
  await until(() => evaluate(`document.querySelector('#gitRepoMessage').textContent.includes('AI 未能')&&!document.querySelector('#gitRepoUpload').disabled`), 'failed AI returns editable review without pushing');
  assert.equal(calls('upload').length, 0);
  assert.equal(await evaluate(`document.querySelector('#gitCommitMessage').value`), '');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#gitUploadFiles input:checked')].map(input=>input.value)`), ['README.md']);
  pass('Blank description analyses selected changes; failure preserves the review without submitting');
  await change('#gitCommitMessage', 'Update only the README');
  await evaluate(`for(const box of document.querySelectorAll('#gitUploadFiles input[type="checkbox"]')){box.checked=box.value==='README.md';box.dispatchEvent(new Event('change',{bubbles:true}))}`);
  const reviewScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reports, 'upload-review.png'), Buffer.from(reviewScreenshot.data, 'base64'));
  assert.equal(calls('upload').length, 0); pass('Upload review displays repository, branch, selected files and explicit submit control');
  configure({ projectBusy: true }); await click('#gitRepoUpload');
  await until(async () => (await dialogText()).includes('正在执行') || (await dialogText()).includes('正在运行'), 'running project protects upload');
  await until(() => evaluate(`document.querySelector('#gitRepositoryDialog').getAttribute('aria-busy')==='false'`), 'busy rejection releases controls');
  assert.equal(calls('upload').length, 0);
  assert.equal(await evaluate(`document.querySelector('#gitCommitMessage').value`), 'Update only the README');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#gitUploadFiles input:checked')].map(input=>input.value)`), ['README.md']);
  pass('Real main IPC blocks Git mutation while the project is running and preserves the review');
  configure({ projectBusy: false, holdUpload: true, failUpload: true }); await click('#gitRepoUpload');
  await until(() => calls('upload').length === 1, 'explicit upload starts'); await click('#gitRepoUpload');
  assert.equal(calls('upload').length, 1); assert.equal(await evaluate(`document.querySelector('#gitRepoUpload').disabled`), true);
  assert.equal(calls('commit-ai').length, 1, 'Handwritten descriptions bypass AI');
  assert.equal(await evaluate(`document.querySelector('#gitRepoUpload').textContent`), '推送中…');
  assert.equal(await evaluate(`document.querySelector('#gitRepoMessage').textContent`), '');
  assert.equal(await evaluate(`[...document.querySelectorAll('#gitRepositoryDialog button,#gitRepositoryDialog input')].every(element=>element.disabled)`), true);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const backdrop = await evaluate(`(()=>{const panel=document.querySelector('#gitRepositoryDialog .modal-panel').getBoundingClientRect();return {x:Math.max(1,panel.left-25),y:panel.top+20}})()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...backdrop, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...backdrop, button: 'left', clickCount: 1 });
  await sleep(250);
  assert.equal(await dialogVisible(), true); assert.equal(await evaluate(`document.querySelector('#gitRepositoryDialog').open`), true);
  assert.equal(await evaluate(`document.querySelector('#gitRepositoryDialog').getAttribute('aria-busy')`), 'true');
  pass('Actual Escape key and backdrop click keep a busy repository dialog open');
  configure({ holdUpload: false }); await until(async () => (await dialogText()).includes('Fixture upload failed') && await evaluate(`!document.querySelector('#gitRepoUpload').disabled`), 'upload failure is retryable');
  assert.equal(await evaluate(`document.querySelector('#gitCommitMessage').value`), 'Update only the README');
  assert.deepEqual(calls('upload')[0].input.files, ['README.md']); assert.equal(calls('upload')[0].input.message, 'Update only the README');
  pass('Busy upload prevents duplicate submission and failure preserves the review for retry');
  configure({ failUpload: false, holdTree: true }); await click('#gitRepoUpload'); await until(() => calls('upload').length === 2, 'upload retry');
  await until(() => evaluate(`!!document.querySelector('#gitRepoUpdate')&&document.querySelector('#gitRepositoryDialog').getAttribute('aria-busy')==='true'`), 'new management controls during post-upload refresh');
  assert.equal(await evaluate(`[...document.querySelectorAll('#gitRepositoryDialog button,#gitRepositoryDialog input')].every(element=>element.disabled)`), true);
  configure({ holdTree: false });
  await until(() => evaluate(`!!document.querySelector('#gitRepoUpdate')&&document.querySelector('#gitRepositoryDialog').getAttribute('aria-busy')==='false'`), 'manage refreshed after upload');
  assert.deepEqual(calls('upload')[1].input.files, ['README.md']); assert.equal(calls('upload')[1].input.account, 'alice');
  pass('Retry uploads selected files; newly rendered controls remain disabled until refresh finishes');

  assert.equal(await evaluate(`document.querySelector('#gitRepoUpdate').disabled`), true, 'Unselected local changes protect update');
  await until(() => evaluate(`document.querySelectorAll('#gitUploadFiles input[type="checkbox"]').length===1`), 'remaining unselected file');
  assert.equal(await evaluate(`document.querySelector('#gitUploadFiles input').value`), 'notes.txt');
  await change('#gitCommitMessage', '   '); configure({ holdAI: true, failAI: false, holdUpload: true, failUpload: true }); await click('#gitRepoUpload');
  await until(() => calls('commit-ai').length === 2, 'remaining selected file analysed once');
  assert.deepEqual(calls('commit-context')[1].input.files, ['notes.txt']);
  configure({ holdAI: false });
  await until(() => calls('upload').length === 3, 'AI fills description then submits automatically');
  assert.equal(await evaluate(`document.querySelector('#gitCommitMessage').value`), '更新 notes.txt 的改动');
  assert.equal(calls('upload')[2].input.message, '更新 notes.txt 的改动');
  for (const theme of ['light', 'dark', 'glass']) {
    await applyTheme(theme); await settleAnimations('push button progress ' + theme); await checkBottomActions();
    assert.equal(await evaluate(`(()=>{const button=document.querySelector('#gitRepoUpload'),s=getComputedStyle(button,'::before'),r=button.getBoundingClientRect(),p=document.querySelector('.git-repository-panel').getBoundingClientRect();return button.textContent==='推送中…'&&button.classList.contains('is-loading')&&s.animationName==='spin'&&r.right<=p.right&&!document.querySelector('#gitRepoMessage').textContent})()`), true);
    const shot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(reports,'push-progress-'+theme+'.png'),Buffer.from(shot.data,'base64'));
  }
  configure({ holdUpload: false });
  await until(() => evaluate(`document.querySelector('#gitRepoMessage').textContent.includes('Fixture upload failed')&&!document.querySelector('#gitRepoUpload').disabled`), 'AI generated description survives a failed push');
  assert.equal(await evaluate(`document.querySelector('#gitCommitMessage').value`), '更新 notes.txt 的改动');
  configure({ failUpload: false }); await click('#gitRepoUpload');
  await until(() => calls('upload').length === 4 && evaluate(`!!document.querySelector('#gitRepoUpdate')&&!document.querySelector('#gitRepoUpdate').disabled`), 'remaining file explicitly submitted');
  assert.equal(calls('commit-ai').length, 2, 'Push retry reuses the generated description');
  assert.deepEqual(calls('upload')[2].input.files, ['notes.txt']); pass('Unselected files remain dirty until another explicit submission');
  pass('AI fills the description before push; progress stays inside the button across themes');
  for (const theme of ['light', 'dark', 'glass']) {
    await applyTheme(theme); await settleAnimations('empty repository ' + theme);
    await checkBottomActions();
    assert.equal(await evaluate(`(()=>{const p=document.querySelector('.git-repository-panel');return !document.querySelector('.git-pending-split,.git-pending-detail,#gitCommitMessage')&&!!document.querySelector('.git-pending-empty')&&document.querySelector('#gitRepoUpload').disabled&&p.getBoundingClientRect().height<400&&p.scrollWidth<=p.clientWidth+1})()`),true,'Clean repository uses compact empty state');
    const shot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(reports,'empty-'+theme+'.png'),Buffer.from(shot.data,'base64'));
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 760, height: 700, deviceScaleFactor: 1, mobile: false });
  await settleAnimations('narrow empty repository'); await checkBottomActions();
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  pass('Upload completion collapses the empty preview and keeps every action on the bottom row across themes');

  configure({ pendingOnly: true, holdUpload: true }); await click('#gitRepoRefresh');
  await until(() => evaluate(`!document.querySelector('#gitRepoUpload')?.disabled`), 'committed-only push is available');
  await click('#gitRepoUpload'); await until(() => calls('upload').length === 5, 'already committed changes pushed without analysis');
  assert.equal(calls('commit-ai').length, 2); assert.deepEqual(calls('upload')[4].input.files, []); assert.equal(calls('upload')[4].input.message, '');
  configure({ pendingOnly: false, holdUpload: false });
  await until(() => evaluate(`document.querySelector('#gitRepositoryDialog').getAttribute('aria-busy')==='false'&&document.querySelector('#gitRepoUpload').disabled`), 'committed-only push completed');
  pass('Already committed changes skip AI and do not require a new description');

  configure({ projectBusy: true, busyPath: clonedPath });
  const bypassReply = await evaluate(`window.halo.gitRepositoryUpdate(${JSON.stringify({ account: 'alice', fullName: 'alice/private-demo', cwd: workspace })})`);
  assert.equal(bypassReply.ok, false); assert.match(bypassReply.error, /正在执行/); assert.equal(calls('update').length, 0);
  assert.equal(calls('status').at(-1).input.cwd, undefined); pass('Update checks its saved repository path despite an unrelated idle cwd in the IPC input');
  configure({ projectBusy: false, busyPath: null });
  const statusesBefore = calls('status').length; await click('#gitRepoUpdate');
  await until(() => calls('update').length === 1 && calls('status').length > statusesBefore, 'update refreshes repository status');
  await until(() => evaluate(`!document.querySelector('#gitRepoUpdate')?.disabled`), 'update controls restored');
  assert.ok(fs.existsSync(path.join(clonedPath, 'remote-update.txt'))); pass('Update refreshes local repository state and restores controls');
  assert.equal(await evaluate(`document.querySelector('#gitRepoUpdate').textContent`), '已同步');
  assert.equal(await evaluate(`document.querySelector('#gitRepoMessage').textContent`), '');
  await click('#gitRepoUpdate');
  await until(() => evaluate(`document.querySelector('#gitRepoUpdate').textContent==='同步中…'`), 'update progress inside button');
  await until(() => evaluate(`document.querySelector('#gitRepoUpdate').textContent==='已是最新' && !document.querySelector('#gitRepoUpdate').disabled`), 'up-to-date result inside button');
  assert.equal(await evaluate(`document.querySelector('#gitRepoMessage').textContent`), '');
  await closeDialog();
  const listsBeforeCreate = calls('list-start').length, pushesBeforeCreate = calls('upload').length;
  await evaluate(`window.__createFrames=[];window.__createObserver=new MutationObserver(()=>{const d=document.querySelector('#gitRepositoryDialog');if(d.open)window.__createFrames.push({view:d.dataset.view,list:!!d.querySelector('#gitRemoteRepositoryList')})});window.__createObserver.observe(document.querySelector('#gitRepositoryDialog'),{subtree:true,childList:true,attributes:true});`);
  await click('#gitCreate'); await until(() => evaluate(`!!document.querySelector('#gitRepoPrivate')`), 'create repository view');
  assert.equal(calls('list-start').length, listsBeforeCreate, 'New repository does not load clone repository list');
  const createFrames = await evaluate(`window.__createObserver.disconnect();window.__createFrames`);
  assert.ok(createFrames.length > 0 && createFrames.every(frame => frame.view === 'create' && !frame.list), 'New repository opens without an intermediate clone list');
  assert.equal(await evaluate(`document.querySelector('#gitRepoPrivate').checked`), true); assert.equal(calls('create').length, 0);
  assert.equal(await evaluate(`(()=>{const b=document.querySelector('#gitRepoPickerBack'),t=document.querySelector('#gitRepoTitle');return !b.hidden&&!!b.closest('.modal-head')&&!!b.querySelector('svg')&&b.getBoundingClientRect().right<=t.getBoundingClientRect().left&&!document.querySelector('.git-dialog-body #gitRepoPickerBack')})()`), true, 'Back icon sits left of the heading without a duplicate footer button');
  await change('#gitRepoName', 'new-private-repo'); await change('#gitRepoDescription', 'An isolated fixture');
  await click('#gitCreateSubmit'); await until(() => calls('create').length === 1, 'explicit repository creation');
  await until(() => evaluate(`!!document.querySelector('#gitRepoClone')&&document.querySelector('#gitRepositoryDialog').getAttribute('aria-busy')==='false'`), 'created repository management');
  assert.equal(calls('create')[0].input.private, true); assert.equal(calls('upload').length, pushesBeforeCreate);
  assert.equal((await localRows()).some(row => row.fullName === 'alice/new-private-repo'), false);
  pass('New remote repository defaults to private and stays out of the sidebar until explicitly associated');

  assert.equal(await evaluate(`!!document.querySelector('#gitRepoBind') || typeof window.halo.gitRepositoryBind !== 'undefined'`), false);
  assert.equal(await evaluate(`document.querySelector('#gitCloneDirectory').value`), cloneParent, 'Saved clone directory appears in editable field');
  configure({ cancelPick: true }); await click('#gitCloneBrowse');
  await until(() => calls('directory-picker').length === 3, 'next clone uses saved default');
  assert.equal(calls('directory-picker')[2].defaultPath, cloneParent);
  await until(() => evaluate(`!document.querySelector('#gitRepoClone')?.disabled`), 'cancelled clone controls restored');
  assert.equal(calls('clone').length, 1);
  assert.equal(calls('bind').length, 0);
  await change('#gitCloneDirectory', 'relative-folder');
  await until(async () => (await dialogText()).includes('完整的本地目录路径'), 'invalid directory rejected');
  await change('#gitCloneDirectory', uploadWorkspace);
  await until(() => evaluate(`window.halo.gitRepositoryStatus({account:'alice',fullName:'alice/new-private-repo'}).then(r=>r.data.cloneDirectory)`).then(value=>value===uploadWorkspace), 'typed directory automatically saved');
  await closeDialog(); await manage('alice/new-private-repo');
  assert.equal(await evaluate(`document.querySelector('#gitCloneDirectory').value`), uploadWorkspace);
  assert.equal(calls('clone').length, 1, 'Saving the default does not clone');
  assert.equal(await evaluate(`!!document.querySelector('#gitCloneSave,.git-clone-label')`), false);
  await settleAnimations('directory materials applied');
  const directoryBorders = await evaluate(`['#gitCloneDirectory','#gitCloneBrowse'].map(selector=>{const s=getComputedStyle(document.querySelector(selector));return [s.borderRadius,s.borderTopWidth,s.borderTopStyle,s.borderTopColor]})`);
  assert.deepEqual(directoryBorders[0], directoryBorders[1], 'Browse matches input border and radius');
  await settleAnimations('editable clone directory');
  const cloneDirectoryScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reports, 'clone-directory.png'), Buffer.from(cloneDirectoryScreenshot.data, 'base64'));
  pass('Clone directory supports browsing, cancellation, validation and saving typed changes before cloning');
  await closeDialog();
  const activeBeforeFolder = (await evaluate('window.halo.getState()')).data.cwd;
  await manage('team/shared-readonly');
  assert.equal(await evaluate(`document.querySelector('#gitRepoOpen').textContent`), '打开文件夹');
  await click('#gitRepoOpen');
  await until(() => calls('open-folder').length === 1, 'repository folder opens in system file manager');
  assert.equal(path.resolve(calls('open-folder')[0].directory), path.resolve(workspace));
  assert.equal((await evaluate('window.halo.getState()')).data.cwd, activeBeforeFolder);
  assert.equal(await dialogVisible(), true);
  pass('Open folder uses the saved repository directory without switching the active project');

  const beforeForeign = calls('list-start').length; configure({ untrusted: true });
  await until(() => calls('untrusted-result').length === 1, 'foreign web contents invoke actual repository IPC');
  const foreignReply = calls('untrusted-result')[0].reply;
  assert.equal(foreignReply.ok, false); assert.match(foreignReply.error, /不可信/); assert.equal(calls('list-start').length, beforeForeign);
  pass('Actual repository IPC rejects a foreign window before reaching account or repository APIs');
  assert.deepEqual(exceptions, [], 'No renderer exceptions');
  fs.writeFileSync(path.join(reports, 'report.json'), JSON.stringify({ at: new Date().toISOString(), passed, themes, pickerLayouts, stages: calls(), network: 'disabled', realIPC: true, gitMutations: 'fixture; separately tested in backend regression' }, null, 2));
  console.log(`PASS Git repositories: ${passed.length} checks`);
} catch (error) {
  if (ws?.readyState === WebSocket.OPEN) {
    const screenshot = await command('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (screenshot) fs.writeFileSync(path.join(reports, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
  }
  fs.writeFileSync(path.join(reports, 'failure.json'), JSON.stringify({ at: new Date().toISOString(), passed, error: error.stack, stages: calls() }, null, 2));
  throw error;
} finally {
  configure({ holdList: false, holdUpload: false, holdTree: false, holdAI: false, holdPreview: false });
  for (const item of pending.values()) clearTimeout(item.timer);
  pending.clear(); ws?.close(); child.kill();
  if (exitCode === undefined) await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (exitCode === undefined) throw Error('Repository test Electron did not exit');
  if (path.dirname(path.resolve(fixture)) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('halo-git-repositories-')) throw Error('Unsafe repository test cleanup');
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
