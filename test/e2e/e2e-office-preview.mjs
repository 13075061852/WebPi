import { readFileSync } from 'node:fs';
import { runOffice } from '../../src/main/office/tools.mjs';
/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 9333;
const electron = spawn(
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'halo-render-'))}`],
  { stdio: ["ignore", "pipe", "pipe"] }
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
 await evalJS('window.halo.projectSwitch('+JSON.stringify(fixture)+')');
 for(const [ext,name] of [['docx','report.docx'],['xlsx','budget.xlsx'],['pptx','presentation.pptx']]) {
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
 await screenshot('test/shot-preview-'+ext+'.png');
 }
 const pdf=await evalJS("window.halo.documentPreview('report.pdf',2).then(r=>({ok:r.ok,pages:r.data?.pages,image:r.data?.image?.slice(0,22),error:r.error}))");
 console.log('PDF',pdf);if(!pdf.ok||pdf.pages!==2)throw Error('PDF failed');
 const markup=readFileSync('src/renderer/js/app.js','utf8').split('\n').find(line=>line.includes('body.innerHTML =')&&line.includes('class="document-preview"'));
 const layout=await evalJS(`(async()=>{const body=document.querySelector('#pvBody');const page=2,pages=2;${markup};const r=await window.halo.documentPreview('report.pdf',2);body.querySelector('img').src=r.data.image;const frame=body.querySelector('.document-preview'),nav=frame.querySelector('nav'),canvas=frame.querySelector('.document-canvas');return {bottom:Math.abs(nav.getBoundingClientRect().bottom-frame.getBoundingClientRect().bottom)<2,separate:canvas.getBoundingClientRect().bottom<=nav.getBoundingClientRect().top};})()`);
 if(!layout.bottom||!layout.separate)throw Error('PDF footer layout '+JSON.stringify(layout));
 await sleep(300);await screenshot('test/shot-preview-pdf.png');
} finally {ws.close();electron.kill();}


