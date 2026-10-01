/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from 'node:net';

const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const PORT = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const fixture = mkdtempSync(path.join(tmpdir(), 'halo-render-'));
const profile = path.join(fixture, 'profile'), workspace = path.join(fixture, 'workspace'), agent = path.join(fixture, 'agent');
for (const dir of [profile, workspace, agent]) mkdirSync(dir);
writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd:workspace, projects:[{cwd:workspace}] }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE)/i.test(key)));
Object.assign(env, { USERPROFILE:fixture, HOME:fixture, APPDATA:path.join(fixture,'roaming'), LOCALAPPDATA:path.join(fixture,'local'), PI_CODING_AGENT_DIR:agent, PI_OFFLINE:'1' });
const electron = spawn(
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`],
  { env, windowsHide:true, stdio: ["ignore", "pipe", "pipe"] }
);
electron.stderr.on("data", () => {});
electron.on("exit", (c) => console.log("electron exited", c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findMainPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const main = list.find((t) => t.type === "page" && t.url.endsWith("index.html"));
      if (main) return main;
    } catch {}
    await sleep(500);
  }
  throw new Error("main window not found");
}

const main = await findMainPage();
console.log("connected:", main.title);
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleLogs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
function send(method, params = {}, sessionId) {
  return new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evalJS(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
async function screenshot(file) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  console.log("saved", file);
}

await send("Runtime.enable");
await send("Page.enable");

// wait for the app + debug hook
let ready = false;
for (let i = 0; i < 30; i++) {
  try { ready = await evalJS("!!window.__haloDispatch"); } catch {}
  if (ready) break;
  await sleep(500);
}
if (!ready) throw new Error("__haloDispatch not available");
console.log("app ready, injecting scenarios...");

// make the layout deterministic for the shot
await evalJS(`
  document.body.classList.add('enter');
`);

// ---- Scenario A: happy path with tool call, streaming, queue chip ----
await evalJS(`(async () => {
  const d = window.__haloDispatch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  d({ type: "agent_start" });
  await sleep(250);
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  for (const ch of ["用户想让我了解项目。", "先查看目录结构。"]) {
    d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: ch } });
    await sleep(120);
  }
  const text = "我先看一下项目的目录结构，再决定怎么做。";
  for (const w of text.split("")) {
    d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: w } });
    if (Math.random() < 0.2) await sleep(25);
  }
  d({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "toolUse" } });
  await sleep(200);
  d({ type: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: { path: "." } });
  await sleep(700);
  d({ type: "tool_execution_update", toolCallId: "t1", partial: { args: { path: "." } } });
  d({ type: "tool_execution_end", toolCallId: "t1", isError: false,
      result: { content: [{ type: "text", text: "src/\\nassets/\\npackage.json\\nREADME.md\\nOPTIMIZATIONS.md" }] } });
  await sleep(250);
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  const t2 = "**项目结构** 很清晰：\\n\\n- src/ —— 主进程与渲染层\\n- assets/ —— 图标资源\\n\\n需要我继续优化 UI 吗？";
  let buf = "";
  for (const w of t2.split("")) {
    buf += w;
    d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: w } });
    await sleep(12);
  }
  d({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: t2 }],
      stopReason: "endTurn", usage: { input: 1200, output: 340, cacheRead: 8200, cacheWrite: 260, cost: { total: 0.0123 } } } });
  d({ type: "agent_end", messages: [], willRetry: false });
  d({ type: "agent_settled" });
  d({ type: "queue_update", steering: ["把发送按钮改成渐变色"], followUp: [""],
    steeringAttachments: [["参考图.png"]], followUpAttachments: [["截图.png"]] });
})()`);
await sleep(600);
await screenshot("test/shot-happy.png");

// ---- DOM 结构断言（不只截图，验证渲染结果） ----
const domCheck = await evalJS(`({
  turns: document.querySelectorAll("#messages > .turn").length,
  mdText: [...document.querySelectorAll("#messages .md")].map(n => n.textContent).join("|"),
  hasBold: !!document.querySelector("#messages .md b"),
  toolCards: document.querySelectorAll("#messages .tool").length,
  toolDone: !!document.querySelector("#messages .tool.done"),
  queueChips: document.querySelectorAll("#queueRow .queue-chip").length,
  queueImages: document.querySelector("#queueRow")?.textContent.includes("参考图.png") &&
    document.querySelector("#queueRow")?.textContent.includes("截图.png"),
  stats: document.querySelector("#chatStats")?.textContent || "",
})`);
console.log("dom check:", JSON.stringify(domCheck));
if (!domCheck.turns || !domCheck.mdText.includes("项目结构") || !domCheck.hasBold || !domCheck.toolCards || !domCheck.toolDone || domCheck.queueChips !== 2 || !domCheck.queueImages || !domCheck.stats) {
  console.log("DOM VERIFY FAILED");
  electron.kill();
  process.exit(1);
}
console.log("DOM VERIFY OK");

// Long tool errors in a narrow chat must never overlap the live status row.
await evalJS(`
  document.querySelector('#messages').innerHTML = '';
  document.querySelector('#messages').style.height = '340px';
  document.querySelector('#messages').style.flex = 'none';
  document.querySelector('#messages').style.width = '460px';
  const d = window.__haloDispatch;
  d({ type: 'agent_start' });
  d({ type: 'tool_execution_start', toolCallId: 'layout-error', toolName: 'bash', args: { command: 'python -c "import matplotlib"' } });
  d({ type: 'tool_execution_end', toolCallId: 'layout-error', isError: true,
    result: { content: [{ type: 'text', text: 'Traceback (most recent call last):\\n' + '    diagnostic output\\n'.repeat(24) + "ModuleNotFoundError: No module named 'matplotlib'" }] } });
`);
await sleep(700);
const errorCollapsed = await evalJS("document.querySelector('.tool.error .tool-out').hidden");
if (!errorCollapsed) { electron.kill(); throw new Error('Failed tools should start collapsed'); }
await evalJS("document.querySelector('.tool.error .tool-line').click()");
for (const theme of ['light', 'dark']) {
  await evalJS(`document.documentElement.dataset.theme = '${theme}'`);
  const layout = await evalJS(`(() => {
    const messages = document.querySelector('#messages');
    const tool = messages.querySelector('.tool');
    const status = messages.querySelector('.turn-status');
    return { separated: status.getBoundingClientRect().bottom <= tool.getBoundingClientRect().top,
      scrolls: messages.scrollHeight > messages.clientHeight,
      fits: messages.scrollWidth <= messages.clientWidth,
      logScrolls: tool.querySelector('.tool-out').scrollHeight > tool.querySelector('.tool-out').clientHeight };
  })()`);
  if (Object.values(layout).some(v => !v)) {
    electron.kill();
    throw new Error('Chat layout regression: ' + JSON.stringify(layout));
  }
  await screenshot('test/shot-output-' + theme + '.png');
}
await evalJS(`
  window.__haloDispatch({ type: 'agent_end', messages: [], willRetry: false });
  window.__haloDispatch({ type: 'agent_settled' });
  document.querySelector('#messages').removeAttribute('style');
`);

// ---- Scenario B: error path with retry ----
await evalJS(`(async () => {
  const d = window.__haloDispatch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  d({ type: "agent_start" });
  await sleep(200);
  const em = '429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}';
  d({ type: "message_start", message: { role: "assistant", content: [], provider: "zai-coding-cn", model: "glm-5.3-flash", stopReason: "error", errorMessage: em } });
  d({ type: "message_end", message: { role: "assistant", content: [], provider: "zai-coding-cn", model: "glm-5.3-flash", stopReason: "error", errorMessage: em } });
  d({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: em });
  d({ type: "agent_end", messages: [], willRetry: true });
})()`);
await sleep(500);
await screenshot("test/shot-error.png");

// ---- zoom clamp sanity（nebula.js 已于 4c0d779 移除，画布不再存在于 UI 中，跳过） ----

console.log("console errors during test:", consoleLogs.length ? consoleLogs : "none");

// Windows Markdown documents: real headings and readable document layout.
await evalJS(`
  const source = ['# AI 模型能力排行榜汇总', '', '> 数据抓取时间：**2026-09-11** ｜ 来源：示例数据', '', '## 1. 综合能力', '', '这是一份用于检查文档排版的示例，**并非真实排名**。', '', '### 1.1 文本综合', '', '| 排名 | 模型 | 分数 | 机构 |', '| ---: | --- | ---: | --- |', '| 1 | Example Alpha | 1507.2 | 示例机构 |', '| 2 | Example Beta | 1488.7 | 示例机构 |', '', '## 2. 使用说明', '', '- 标题层级清晰', '- 表格在窄窗口内滚动', '', '\`\`\`python', 'print("Hello, Markdown")', '\`\`\`'].join('\\r\\n');
  document.querySelector('#pvBody').innerHTML = '<div class="md-view">' + mdRender(source) + '</div>';
`);
for (const theme of ['light', 'dark']) {
  await evalJS(`document.documentElement.dataset.theme = '${theme}'`);
  const valid = await evalJS(`(() => {
    const doc = document.querySelector('.md-view');
    return doc.querySelectorAll('h1').length === 1 && doc.querySelectorAll('h2').length === 2 &&
      doc.querySelectorAll('td').length === 8 && doc.scrollWidth <= doc.clientWidth;
  })()`);
  if (!valid) { electron.kill(); throw new Error('Markdown preview regression'); }
  await screenshot('test/shot-document-' + theme + '.png');
}
await evalJS(`document.querySelector('#btnSettings').click(); document.querySelector('[data-pane="proxy"].set-nav').click();`);
await sleep(300);
// Replace form listeners with a fixture: UI tests must never modify the host system proxy.
await evalJS(`(async () => {
  const old = document.querySelector('#proxyForm'); old.replaceWith(old.cloneNode(true));
  window.__proxyFixture = {mode:'direct',port:7890,system:{flags:1,server:''}};
  const {initProxySettings} = await import('./js/proxy-settings.mjs');
  const controller = initProxySettings({api:{
    proxyGet:async()=>({ok:true,data:window.__proxyFixture}),
    proxySet:async(value)=>({ok:true,data:window.__proxyFixture={...value,port:Number(value.port),system:{flags:value.mode==='proxy'?3:1,server:value.mode==='proxy'?'127.0.0.1:'+value.port:''}}})
  }});
  await controller.refresh();
})()`);
await evalJS(`document.querySelector('#proxyPort').value='65534'; document.querySelector('#proxyApply').click();`);
await sleep(400);
const proxyState = await evalJS('window.__proxyFixture');
if (proxyState?.mode !== 'proxy' || proxyState.port !== 65534) { electron.kill(); throw Error('Proxy UI did not apply'); }
for (const theme of ['light', 'dark']) {
  await evalJS(`document.documentElement.dataset.theme='${theme}'`);
  await sleep(350);
  await screenshot('test/shot-proxy-' + theme + '.png');
}
await evalJS(`document.querySelector('#proxyReset').click()`);
await sleep(400);
if (await evalJS('window.__proxyFixture.mode') !== 'direct') { electron.kill(); throw Error('Proxy reset failed'); }
console.log('PASS proxy settings UI applies a port and restores direct');
// Real relative tool-write preview: exercise URL encoding and dependent assets.
writeFileSync(path.join(workspace, '页面 #%.html'), '<!doctype html><script src="./preview-game.js"></script>');
writeFileSync(path.join(workspace, 'preview-game.js'), 'parent.postMessage({previewRelativeReady:true},"*");');
await evalJS(`window.__relativePreviewReady=false; addEventListener('message',e=>{if(e.data?.previewRelativeReady)window.__relativePreviewReady=true;});
window.__haloDispatch({type:'agent_start'});
window.__haloDispatch({type:'tool_execution_start',toolCallId:'relative-preview',toolName:'write',args:{path:'页面 #%.html'}});
window.__haloDispatch({type:'tool_execution_end',toolCallId:'relative-preview',isError:false,result:{content:[{type:'text',text:'File written'}]}});
window.__haloDispatch({type:'agent_settled'});`);
let relativeReady=false;
for(let attempt=0;attempt<40;attempt++) {
  relativeReady=await evalJS('window.__relativePreviewReady');
  if(relativeReady)break;
  await sleep(100);
}
if(!relativeReady){electron.kill();throw Error('Relative tool path did not auto-open HTML and its script');}
console.log('PASS relative HTML write auto-preview, Chinese/special-character paths and relative script loading');
await evalJS(`document.querySelector('#settingsModal [data-close]').click()`);
for (const theme of ['light','dark']) {
  await evalJS(`document.documentElement.dataset.theme='${theme}'`);
  await sleep(350);
  await screenshot('test/shot-preview-actions-'+theme+'.png');
}
// Render actual attachment code against an isolated draft in the real window.
const appSource = readFileSync('src/renderer/js/app.js', 'utf8');
const attachmentRenderer = appSource.slice(appSource.indexOf('function renderAttachments()'), appSource.indexOf('/* ---- project (A9'));
const attachmentResult = await evalJS(`(() => {
  const S = {images:[], files:[{name:'产品说明.pdf',path:'C:/files/产品说明.pdf'},{name:'数据表.xlsx',path:'C:/files/数据表.xlsx'}],composerRevision:0};
  const $ = (selector, root=document) => root.querySelector(selector);
  const esc = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;');
  const trunc = text => text;
  ${attachmentRenderer}
  renderAttachments();
  const row = $('#attachRow');
  if (row.hidden || row.children.length !== 2) return false;
  row.querySelector('.attach-remove').click();
  if (row.children.length !== 1 || S.files[0].name !== '数据表.xlsx') return false;
  return row.scrollWidth <= row.clientWidth;
})()`);
if (!attachmentResult) { electron.kill(); throw Error('File attachment chip layout/removal failed'); }
await screenshot('test/shot-file-attachments.png');
console.log('PASS ordinary file chips render and remove in Electron');
// Native File objects exercise the real chat drop event, preload and main IPC.
const documentFiles = ['说明.docx', '数据.xlsx', '参考.pdf'].map(name => path.join(workspace,name));
for(const file of documentFiles) writeFileSync(file,'attachment transport fixture');
await evalJS(`document.querySelector('#attachRow').innerHTML='';
  const picker=document.createElement('input');picker.id='nativeAttachmentFixture';picker.type='file';picker.multiple=true;picker.hidden=true;document.body.appendChild(picker);`);
const dom = await send('DOM.getDocument');
const nativePicker = await send('DOM.querySelector',{nodeId:dom.result.root.nodeId,selector:'#nativeAttachmentFixture'});
await send('DOM.setFileInputFiles',{nodeId:nativePicker.result.nodeId,files:documentFiles});
await evalJS(`(() => { const transfer=new DataTransfer();
  for(const file of document.querySelector('#nativeAttachmentFixture').files) transfer.items.add(file);
  document.querySelector('#input').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
})()`);
let nativeChips=[];
for(let attempt=0;attempt<30;attempt++) {
  nativeChips=await evalJS(`Array.from(document.querySelectorAll('#attachRow .attach-chip')).map(n=>n.title)`);
  if(nativeChips.length===3) break;
  await sleep(100);
}
if(documentFiles.some(file=>!nativeChips.includes(file))) {electron.kill();throw Error('Native chat file drop failed: '+JSON.stringify(nativeChips));}
await screenshot('test/shot-native-document-attachments.png');
await evalJS(`while(document.querySelector('#attachRow .attach-remove')) document.querySelector('#attachRow .attach-remove').click();`);
const importTarget=path.join(workspace,'imported');mkdirSync(importTarget);
await evalJS(`document.querySelector('#treeRefresh').click()`);
let targetReady=false;
for(let attempt=0;attempt<30;attempt++) {
  targetReady=await evalJS(`Array.from(document.querySelectorAll('#wsTree .trow.dir')).some(n=>n.title===${JSON.stringify(importTarget)})`);
  if(targetReady)break;
  await sleep(100);
}
if(!targetReady){electron.kill();throw Error('Import target folder did not render');}
await evalJS(`(() => {
  const transfer=new DataTransfer();
  for(const file of document.querySelector('#nativeAttachmentFixture').files)transfer.items.add(file);
  const target=Array.from(document.querySelectorAll('#wsTree .trow.dir')).find(n=>n.title===${JSON.stringify(importTarget)});
  target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
})()`);
let importedReady=false;
for(let attempt=0;attempt<30;attempt++) {
  importedReady=await evalJS(`document.querySelector('#wsTree').getAttribute('aria-busy')!=='true' && Array.from(document.querySelectorAll('#wsTree .trow.file')).filter(n=>n.title.startsWith(${JSON.stringify(importTarget)})).length===3`);
  if(importedReady)break;
  await sleep(100);
}
if(!importedReady){electron.kill();throw Error('Tree import did not refresh its destination');}
for(const source of documentFiles) {
  if(readFileSync(path.join(importTarget,path.basename(source)),'utf8')!==readFileSync(source,'utf8')){electron.kill();throw Error('Imported content differs');}
}
if(await evalJS(`document.querySelectorAll('#attachRow .attach-chip').length`)){electron.kill();throw Error('Tree drop leaked into chat attachments');}
await screenshot('test/shot-tree-import.png');
await evalJS(`document.querySelector('#nativeAttachmentFixture').remove()`);
const deleteFixture=path.join(importTarget,'参考.pdf');
await evalJS(`(() => {
  const tree=document.querySelector('#wsTree');
  Array.from(tree.querySelectorAll('.trow.file')).find(n=>n.title===${JSON.stringify(deleteFixture)}).click();
  const editor=document.createElement('input');tree.appendChild(editor);editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));
  if(tree.querySelector('.trow.selected .trow-del').classList.contains('confirm')) throw Error('Delete intercepted text editing');
  editor.remove();tree.focus();
  tree.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));
  if(!tree.querySelector('.trow.selected .trow-del').classList.contains('confirm')) throw Error('Delete did not request confirmation');
  tree.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',repeat:true,bubbles:true,cancelable:true}));
})()`);
// Key auto-repeat must not count as confirmation.
if(readFileSync(deleteFixture,'utf8')!=='attachment transport fixture'){electron.kill();throw Error('Delete auto-repeat modified file');}
await evalJS(`document.querySelector('#wsTree').dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));`);
let deleted=false;
for(let attempt=0;attempt<30;attempt++) {
  deleted=await evalJS(`!Array.from(document.querySelectorAll('#wsTree .trow.file')).some(n=>n.title===${JSON.stringify(deleteFixture)})`);
  if(deleted)break;
  await sleep(100);
}
if(!deleted){electron.kill();throw Error('Confirmed Delete did not refresh file tree');}
console.log('PASS Delete confirms removal, ignores text editing and ignores held-key repeats');
console.log('PASS native tree drop imports files into the folder, refreshes tree and does not attach to chat');
console.log('PASS Word/Excel/PDF native drop into chat through preload and main IPC');
// Use the production loading markup without issuing a marketplace request.
const loadingMarkup = appSource.match(/box\.innerHTML = `(<div class="pkg-loading"[\s\S]*?)`;/)[1];
await evalJS(`document.querySelector('#settingsModal').hidden=false; document.querySelector('#settingsModal').classList.add('show');
  document.querySelectorAll('.set-pane').forEach(p=>p.classList.toggle('active',p.id==='setPane-pkgs'));
  document.querySelectorAll('.set-nav').forEach(p=>p.classList.toggle('active',p.dataset.pane==='pkgs'));
  document.querySelector('#pkgInstalledSec').hidden=true;
  document.querySelector('#pkgMarketSec').hidden=false;
  document.querySelector('#pkgMarket').innerHTML=${JSON.stringify(loadingMarkup)};
  document.documentElement.dataset.theme='light';`);
await sleep(250);
const loadingGeometry = await evalJS(`(() => {
  const box=document.querySelector('#pkgMarket').getBoundingClientRect();
  const loading=document.querySelector('.pkg-loading').getBoundingClientRect();
  const spinner=document.querySelector('.pkg-loading-spinner');
  return {dx:Math.abs(box.x+box.width/2-loading.x-loading.width/2),
    dy:Math.abs(box.y+box.height/2-loading.y-loading.height/2),height:box.height,
    spinning:spinner.getAnimations().some(a=>a.playState==='running'),border:getComputedStyle(spinner).borderTopWidth};
})()`);
if(loadingGeometry.dx>1 || loadingGeometry.dy>1 || loadingGeometry.height<200 || !loadingGeometry.spinning || loadingGeometry.border==='0px') {
  electron.kill(); throw Error('Marketplace loading alignment/motion: '+JSON.stringify(loadingGeometry));
}
await screenshot('test/shot-market-loading.png');
console.log('PASS marketplace loading centered with active spinner',loadingGeometry);
ws.close();
electron.kill();
process.exit(0);
