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
 const live=await evalJS(`(()=>{
 const d=window.__haloDispatch; d({type:'agent_start'});
 for(let i=0;i<7;i++){
 d({type:'tool_execution_start',toolCallId:'compact-'+i,toolName:'read',args:{path:'file-'+i}});
 d({type:'tool_execution_end',toolCallId:'compact-'+i,isError:i===2,result:{content:[{type:'text',text:'result '+i}]}});
 }
 const turn=document.querySelector('.turn');
 return {visible:turn.querySelectorAll(':scope > .tool').length, archived:turn.querySelectorAll('.tool-history .tool').length,statusAtTop:!!turn.querySelector('.tool-history > summary > .turn-status'),oldLabel:turn.textContent.includes('较早的过程'),open:turn.querySelector('.tool-history').open};
 })()`);
 if(live.visible!==1||live.archived!==6||live.open||!live.statusAtTop||live.oldLabel)throw Error(JSON.stringify(live));
 const ended=await evalJS(`(()=>{
 const d=window.__haloDispatch;
 d({type:'agent_settled'});
 const turn=document.querySelector('.turn');
 return {visible:turn.querySelectorAll(':scope > .tool').length,archived:turn.querySelectorAll('.process-group .tool').length,open:turn.querySelector('.process-group').open,nested:turn.querySelectorAll('.tool-history').length};
 })()`);
 if(ended.visible!==0||ended.archived!==7||ended.open||ended.nested)throw Error(JSON.stringify(ended));
 console.log('PASS latest tool visible; older tools collapsed; completed process entirely collapsed');
} finally {ws.close();electron.kill();}
