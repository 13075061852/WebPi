/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 9357;
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
const running = { state:{ready:true,isStreaming:true,sessionId:'restore-A'},seq:20,startedAt:Date.now()-60000,activeTools:{tool1:'bash'},messages:[{role:'user',content:[{type:'text',text:'执行任务'}]},{role:'assistant',content:[{type:'text',text:'正在处理项目'},{type:'toolCall',id:'tool1',name:'bash',arguments:{command:'sleep 60'}}]}] };
await evalJS('window.__haloRestoreView('+JSON.stringify(running)+')');
const check = await evalJS(`({status:document.querySelector('.turn-status')?.textContent, completed:!!document.querySelector('.turn.complete'), stop:document.querySelector('#btnSend').classList.contains('streaming')})`);
if(!check.status?.includes('bash') || check.completed || !check.stop) throw Error(JSON.stringify(check));
await evalJS('window.__haloRestoreView('+JSON.stringify({state:{ready:true,isStreaming:false,sessionId:'restore-B'},messages:[],seq:0})+')');
if(await evalJS(`document.querySelector('#btnSend').classList.contains('streaming')`)) throw Error('Idle session marked busy');
await evalJS('window.__haloRestoreView('+JSON.stringify(running)+')');
await evalJS(`window.__haloDispatch({type:'tool_execution_end',toolCallId:'tool1',isError:false,result:{content:[{type:'text',text:'完成工具'}]}},'restore-A')`);
if(!await evalJS(`!!document.querySelector('.tool.done')`)) throw Error('Tool did not resume');
const partial={...running,activeTools:{},messages:[],partial:{role:'assistant',content:[{type:'text',text:'第一部分'}]}};
await evalJS('(async () => { const restoring = window.__haloRestoreView('+JSON.stringify(partial)+'); window.__haloDispatch({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"重复"}},"restore-A",20); window.__haloDispatch({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"衔接"}},"restore-A",21); await restoring; })()');
await evalJS(`window.__haloDispatch({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'第二部分'}},'restore-A')`);
await sleep(1200);
if(!await evalJS(`document.querySelector('.md').textContent.includes('第一部分衔接第二部分')`)) throw Error('Partial text not resumed');
await evalJS(`window.__haloDispatch({type:'agent_settled'},'restore-A')`);
if(await evalJS(`!!document.querySelector('.turn-status')`)) throw Error('Completed state stayed busy');
await screenshot('test/shot-session-restore.png');
console.log('SESSION RESTORE PASS: active tool, idle switch, resume, partial continuation, completion');
} finally { ws.close(); electron.kill(); }

