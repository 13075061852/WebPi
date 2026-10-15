/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {createServer} from 'node:http';

const PORT = 9352;
const website = createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<title>Terminal preview test</title><h1>Preview works</h1>');});
await new Promise(resolve=>website.listen(0,'127.0.0.1',resolve));
const terminalURL = `http://127.0.0.1:${website.address().port}/terminal-preview/`;
const electron = spawn(
  process.env.HALO_TEST_EXECUTABLE || (process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron"),
  [...(process.env.HALO_TEST_EXECUTABLE ? [] : ["."]), `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'halo-render-'))}`],
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
await evalJS(`window.testTerminalRefs=[];const OriginalTerminal=window.Terminal;window.Terminal=class extends OriginalTerminal{constructor(options){super(options);window.testTerminalRefs.push(this)}}`);
// The preview now starts folded; reveal the pane before testing terminal geometry.
await evalJS(`if(document.body.classList.contains('preview-collapsed'))document.querySelector('#btnPreviewToggle').click();`);
await sleep(500);
await evalJS(`window.termOutput = {}; window.halo.onPtyOut(({id,data}) => { window.termOutput[id] = (window.termOutput[id] || '') + data; }); document.querySelector('#btnTerm').click();`);
await sleep(1600);
await evalJS(`document.querySelector('#termAdd').click()`);
await sleep(1400);
const ids = await evalJS(`[...document.querySelectorAll('.terminal-panel')].map(p=>p.dataset.terminalId)`);
const pids = await evalJS(`[...document.querySelectorAll('.terminal-panel')].map(p=>Number(p.dataset.pid))`);
if(ids.length !== 2) throw Error('Two terminals not created');
if (!(await evalJS(`window.testTerminalRefs.every(term => term.options.windowsPty.backend === 'conpty' && term.options.windowsPty.buildNumber > 0)`))) throw Error('Windows terminal compatibility metadata missing');
await evalJS('window.halo.ptyWrite('+JSON.stringify({id:ids[1],data:'echo HALO_RESIZE_A & echo HALO_RESIZE_B & echo HALO_RESIZE_C\r'})+')');
await sleep(400);
const resizeResult=await evalJS(`(async()=>{
  const term=window.testTerminalRefs[1], host=document.querySelector('#termHost');
  const lines=()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true));
  const before=lines().map(line=>line.trim()).filter(line=>/^HALO_RESIZE_[ABC]$/.test(line));
  for(const width of ['75%','90%','70%','85%','100%']){host.style.width=width;await new Promise(r=>setTimeout(r,25));}
  await new Promise(r=>setTimeout(r,350));
  host.style.maxHeight='300px';await new Promise(r=>setTimeout(r,350));
  host.style.maxHeight='';await new Promise(r=>setTimeout(r,350));
  const after=lines().map(line=>line.trim()).filter(line=>/^HALO_RESIZE_[ABC]$/.test(line));
  return {before,after,debug:lines().filter(line=>line.includes('HALO_RESIZE'))};
})()`);
if(JSON.stringify(resizeResult.before)!==JSON.stringify(['HALO_RESIZE_A','HALO_RESIZE_B','HALO_RESIZE_C']) || JSON.stringify(resizeResult.after)!==JSON.stringify(resizeResult.before))throw Error('Terminal resize duplicated/lost output: '+JSON.stringify(resizeResult));
console.log('RESIZE PASS: repeated width/height changes preserve output without duplicate lines');
for(let i=0;i<2;i++) await evalJS('window.halo.ptyWrite('+JSON.stringify({id:ids[i],data:'set HALO_TEST_VALUE=ISOLATED_'+i+'\r'})+')');
await sleep(500);
await evalJS('window.termOutput = {}');
for(const id of ids) await evalJS('window.halo.ptyWrite('+JSON.stringify({id,data:'echo %HALO_TEST_VALUE%\r'})+')');
await sleep(800);
const outputs=await evalJS('window.termOutput');
for(let i=0;i<2;i++) if(!outputs[ids[i]]?.includes('ISOLATED_'+i) || outputs[ids[i]].includes('ISOLATED_'+(1-i))) throw Error('Process isolation failed: '+JSON.stringify(outputs));

await evalJS('window.termOutput = {}');
await evalJS('window.halo.ptyWrite('+JSON.stringify({id:ids[1],data:'for /L %i in (1,1,18000) do @echo LOAD_%i_abcdefghijklmnop\r'})+')');
let drained=false;
for(let i=0;i<80;i++) {
  drained=await evalJS('(window.termOutput['+JSON.stringify(ids[1])+'] || "").includes("LOAD_18000_abcdefghijklmnop")');
  if(drained) break; await sleep(150);
}
if(!drained) throw Error('High volume output stalled');
await evalJS('window.halo.ptyWrite('+JSON.stringify({id:ids[1],data:'ping -t 127.0.0.1\r'})+')');
await sleep(700);
await evalJS('window.halo.ptyWrite('+JSON.stringify({id:ids[1],data:'\x03'})+')');
await sleep(600);
await evalJS('window.termOutput = {}');
await evalJS('window.halo.ptyWrite('+JSON.stringify({id:ids[1],data:'echo %HALO_TEST_VALUE%\r'})+')');
await sleep(700);
if(!(await evalJS('window.termOutput['+JSON.stringify(ids[1])+']'))?.includes('ISOLATED_1')) throw Error('Ctrl+C lost shell state');
console.log('FLOW CONTROL PASS: 18000 lines drained; Ctrl+C preserved shell environment');
await evalJS(`document.querySelector('#termSplit').click();`);
await sleep(400);
const sizes=await evalJS(`[...document.querySelectorAll('.terminal-panel')].map(p=>({visible:!p.hidden,width:p.clientWidth,height:p.clientHeight}))`);
if(sizes.some(s=>!s.visible || s.width < 100 || s.height < 100)) throw Error('Split layout failed');
await screenshot('test/shot-terminals.png');
// Startup state restoration can fold the preview after the initial toggle.
await evalJS(`if(document.body.classList.contains('preview-collapsed'))document.querySelector('#btnPreviewToggle').click();`);
await sleep(500);
await evalJS(`if(!document.querySelector('#cpane-preview').classList.contains('term-open'))document.querySelector('#btnTerm').click();`);
await sleep(250);
await evalJS('window.halo.ptyWrite('+JSON.stringify({id:ids[1],data:`echo ${terminalURL}\r`})+')');
await sleep(400);
const linkPoint=await evalJS(`(async()=>{
  const term=window.testTerminalRefs[1],buffer=term.buffer.active;
  const {createTerminalLinkProvider}=await import('./js/terminal-links.mjs');
  const provider=createTerminalLinkProvider(term,()=>{});
  for(let y=buffer.viewportY+1;y<=buffer.viewportY+term.rows;y++) {
    const links=await new Promise(resolve=>provider.provideLinks(y,resolve));
    const link=links?.find(link=>link.text===${JSON.stringify(terminalURL)}&&link.range.start.y===y);
    if(!link)continue;
    const screen=document.querySelectorAll('.xterm-screen')[1].getBoundingClientRect();
    return {x:screen.left+(link.range.start.x-.5)*screen.width/term.cols,y:screen.top+(y-buffer.viewportY-.5)*screen.height/term.rows};
  }
  throw Error('Terminal URL was not printed');
})()`);
await send('Input.dispatchMouseEvent',{type:'mouseMoved',...linkPoint});await sleep(150);
await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...linkPoint});
await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...linkPoint});
await sleep(800);
const linkPreview=await evalJS(`({src:document.querySelector('#pvBody webview')?.getAttribute('src'),terminal:document.querySelector('#cpane-preview').classList.contains('term-open'),count:document.querySelectorAll('.terminal-panel').length,hit:document.elementFromPoint(${linkPoint.x},${linkPoint.y})?.className})`);
if(linkPreview.src!==terminalURL||linkPreview.terminal||linkPreview.count!==2){await screenshot('tmp/terminal-link-failed.png');throw Error('Terminal link must open in preview while retaining terminal processes: '+JSON.stringify({linkPreview,linkPoint}));}
await evalJS(`document.querySelector('#btnTerm').click();`);
console.log('LINK PREVIEW PASS: real URL click opens internal preview and retains terminals');
await evalJS(`document.querySelector('#btnTerm').click(); document.querySelector('#btnTerm').click();`);
if(await evalJS(`document.querySelectorAll('.terminal-panel').length`) !== 2) throw Error('Hide destroyed terminals');
await evalJS(`document.querySelector('.terminal-tab button:last-child').click();`);
await sleep(600);
await evalJS('window.termOutput = {}');
await evalJS('window.halo.ptyWrite('+JSON.stringify({id:ids[1],data:'echo %HALO_TEST_VALUE%\r'})+')');
await sleep(600);
if(!(await evalJS('window.termOutput['+JSON.stringify(ids[1])+']'))?.includes('ISOLATED_1')) throw Error('Closing one terminal killed another');
await evalJS(`document.querySelector('.terminal-tab button:last-child').click();`);
if(await evalJS('document.querySelector("#cpane-preview").classList.contains("term-open") || document.querySelector("#btnTerm").classList.contains("active")')) throw Error('Last terminal did not close the pane');
for (let i=0;i<60;i++) {
  const alive=pids.filter(pid=>{try { process.kill(pid,0); return true; } catch { return false; }});
  if(!alive.length) break;
  if(i===59) throw Error('Terminal process leak: '+alive);
  await sleep(100);
}
console.log('TERMINALS PASS: independent shells, input/output, split, hide/reopen, close isolation');
} finally { ws.close(); electron.kill(); website.close(); }
