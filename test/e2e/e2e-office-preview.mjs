import { readFileSync } from 'node:fs';
import { runOffice } from '../../src/main/office/tools.mjs';
import { Document, Packer, Paragraph, TextRun, PageBreak, Table, TableRow, TableCell } from 'docx';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 9333;
const isolated = mkdtempSync(path.join(tmpdir(), 'halo-office-e2e-'));
const profile = path.join(isolated, 'profile'), workspace = path.join(isolated, 'workspace');
for (const dir of [profile, workspace]) mkdirSync(dir);
writeFileSync(path.join(profile, 'halo-settings.json'), JSON.stringify({ cwd: workspace, projects: [{ cwd: workspace }], splashed: true }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE)/i.test(key)));
Object.assign(env, { HOME: isolated, USERPROFILE: isolated, APPDATA: path.join(isolated, 'roaming'), LOCALAPPDATA: path.join(isolated, 'local'), PI_CODING_AGENT_DIR: path.join(isolated, 'agent'), PI_HALO_PI_PATH: path.resolve('test/fixtures/pi-sdk.js'), PI_OFFLINE: '1' });
const electron = spawn(
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`],
  { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
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


try {
 await sleep(1200);
 const root=mkdtempSync(path.join(tmpdir(),'halo-office-preview-'));
 for(const name of ['word','excel','powerpoint','pdf'])await runOffice({action:'run',script:path.resolve('assets/office-examples/'+name+'.cjs')},root);
 const fixture=path.join(root,'output');
 const paragraphs = Array.from({length:65},(_,index)=>new Paragraph({text:`段落${index}：`+'分页预览应保留完整正文与段落格式。'.repeat(10),spacing:{after:160}}));
 const longText='长段落需要跨页排版且不能丢失文字。'.repeat(550);
 const table = new Table({rows:Array.from({length:55},(_,index)=>new TableRow({children:[new TableCell({children:[new Paragraph(`表格行${index}`)]}),new TableCell({children:[new Paragraph('表格跨页内容'.repeat(12))]})]}))});
 const paginated=new Document({sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1134,bottom:1134,left:1134,right:1134}}},children:[...paragraphs,new Paragraph({children:[new TextRun({text:longText,bold:true})]}),table]}]});
 const paginatedBytes=await Packer.toBuffer(paginated);
 writeFileSync(path.join(fixture,'pagination.docx'),paginatedBytes);
 const breaks = new Document({sections:[{children:[new Paragraph('手动分页前'),new Paragraph({children:[new PageBreak(),new TextRun('手动分页后')]}),new Paragraph('保存分页后')]}]});
 const breakZip = await JSZip.loadAsync(await Packer.toBuffer(breaks));
 breakZip.file('word/document.xml',(await breakZip.file('word/document.xml').async('string')).replace('<w:t xml:space="preserve">保存分页后</w:t>','<w:lastRenderedPageBreak/><w:t xml:space="preserve">保存分页后</w:t>'));
 writeFileSync(path.join(fixture,'breaks.docx'),await breakZip.generateAsync({type:'nodebuffer'}));
 await evalJS('window.halo.projectSwitch('+JSON.stringify(fixture)+')');
 await evalJS('if(document.body.classList.contains("preview-collapsed"))document.querySelector("#btnPreviewToggle").click()');
 await sleep(400);
 for(const [ext,name] of [['docx','report.docx'],['docx','pagination.docx'],['docx','breaks.docx'],['xlsx','budget.xlsx'],['pptx','presentation.pptx']]) {
 const result=await evalJS(`(async()=>{
 const r=await window.halo.documentPreview(${JSON.stringify(name)});
 if(!r.ok)throw Error(r.error);
 return new Promise(resolve=>{
 const f=document.createElement('iframe');f.sandbox='allow-scripts allow-same-origin';f.src='document-viewer.html';f.style='width:100%;height:100%';
 const listener=e=>{if(e.source!==f.contentWindow)return;if(e.data.type==='office-ready')f.contentWindow.postMessage({type:'office-document',...r.data},'*');if(e.data.type==='office-rendered'){window.removeEventListener('message',listener);resolve(e.data);}};
 window.addEventListener('message',listener);document.querySelector('#pvBody').replaceChildren(f);
 setTimeout(()=>resolve({error:'timeout'}),15000);
 });})()`);
 console.log(ext,JSON.stringify(result).slice(0,500));if(result.error||!result.nodes||(ext==='pptx' && (result.nodes!==3 || !result.text.includes('项目成果汇报'))))throw Error(ext+' failed');
 if(name==='pagination.docx') {
 const pagination=await evalJS(`(()=>{const doc=document.querySelector('#pvBody iframe').contentDocument;const pages=[...doc.querySelectorAll('.docx-wrapper>section.docx')],content=doc.querySelector('#content');return {pages:pages.length,heights:pages.map(p=>p.offsetHeight),fits:content.scrollWidth<=content.clientWidth+1,overflow:pages.map(p=>p.scrollHeight-p.clientHeight),text:pages.map(p=>[...p.querySelectorAll('article p')].map(p=>p.textContent).join('')).join(''),bold:[...doc.querySelectorAll('article span')].filter(n=>getComputedStyle(n).fontWeight==='700').map(n=>n.textContent).join('')}})()`);
 assert.ok(pagination.pages>5,'Natural overflow must create separate paper pages');
 assert.ok(pagination.heights.every(h=>Math.abs(h-1122.53)<3),'Paper height must stay A4');
 assert.ok(pagination.fits,'Paginated Word pages must fit the preview width without horizontal scrolling');
 assert.ok(pagination.overflow.every(h=>h<=2),'Text/rows must not overflow page bounds');
 const expected=Array.from({length:65},(_,index)=>`段落${index}：`+'分页预览应保留完整正文与段落格式。'.repeat(10)).join('')+longText+Array.from({length:55},(_,index)=>`表格行${index}`+'表格跨页内容'.repeat(12)).join('');
 assert.equal(pagination.text,expected,'Pagination must preserve all text in order');
 assert.equal(pagination.bold,longText,'Splitting a long paragraph must preserve its run formatting');
 assert.deepEqual(readFileSync(path.join(fixture,name)),paginatedBytes,'Preview must not alter the DOCX');
 console.log('PAGINATION PASS',pagination.pages,'A4 pages; complete paragraphs, long rich text and table rows');
 await evalJS('document.querySelector("#pvBody iframe").contentDocument.querySelector("#content").scrollTop=1000');
 }
 if(name==='breaks.docx') {
 const pages=await evalJS('(()=>{const doc=document.querySelector("#pvBody iframe").contentDocument;return [...doc.querySelectorAll(".docx-wrapper>section.docx")].map(page=>page.querySelector("article").textContent)})()');
 assert.equal(pages.length,3,'Explicit and Word-saved page breaks must both remain');
 assert.ok(pages[0].includes('手动分页前') && pages[1].includes('手动分页后') && pages[2].includes('保存分页后'));
 console.log('PAGE BREAK PASS manual and saved Word boundaries');
 }
 await screenshot(path.join(isolated,'preview-'+name+'.png'));
 }
 const pdf=await evalJS("window.halo.documentPreview('report.pdf',2).then(r=>({ok:r.ok,pages:r.data?.pages,image:r.data?.image?.slice(0,22),error:r.error}))");
 console.log('PDF',pdf);if(!pdf.ok||pdf.pages!==2)throw Error('PDF failed');
 const markup=readFileSync('src/renderer/js/app.js','utf8').split('\n').find(line=>line.includes('body.innerHTML =')&&line.includes('class="document-preview"'));
 const layout=await evalJS(`(async()=>{const body=document.querySelector('#pvBody');${markup};const r=await window.halo.documentPreview('report.pdf');const {mountPDFPreview}=await import('./js/pdf-preview.mjs');mountPDFPreview(body.querySelector('.document-canvas'),r.data,page=>window.halo.documentPreview('report.pdf',page));return {pages:body.querySelectorAll('.pdf-page').length,controls:!!body.querySelector('nav,button')};})()`);
 assert.deepEqual(layout,{pages:2,controls:false},'PDF uses continuous scrolling without pagination controls');
 await sleep(300);await screenshot(path.join(isolated,'preview-pdf.png'));
} finally {ws.close();electron.kill();}


