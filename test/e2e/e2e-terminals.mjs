/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 9352;
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
await evalJS(`window.termOutput = {}; window.halo.onPtyOut(({id,data}) => { window.termOutput[id] = (window.termOutput[id] || '') + data; }); document.querySelector('#btnTerm').click();`);
await sleep(1600);
await evalJS(`document.querySelector('#termAdd').click()`);
await sleep(1400);
const ids = await evalJS(`[...document.querySelectorAll('.terminal-panel')].map(p=>p.dataset.terminalId)`);
const pids = await evalJS(`[...document.querySelectorAll('.terminal-panel')].map(p=>Number(p.dataset.pid))`);
if(ids.length !== 2) throw Error('Two terminals not created');
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
} finally { ws.close(); electron.kill(); }
