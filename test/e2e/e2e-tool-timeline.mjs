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
const fixture = mkdtempSync(path.join(tmpdir(), 'halo-timeline-'));
const agent = path.join(fixture, 'agent'); mkdirSync(agent);
writeFileSync(path.join(agent, 'auth.json'), '{}');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|ELECTRON_RUN_AS_NODE)/i.test(key)));
Object.assign(env, { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_HALO_PI_PATH: path.resolve('test/fixtures/pi-sdk.js') });
const electron = spawn(
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'halo-render-'))}`],
  { stdio: ["ignore", "pipe", "pipe"], env }
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
 if(i===0||i===3){
 const message={role:'assistant',content:[{type:'text',text:'阶段进度 '+i}]};
 d({type:'message_start',message});d({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'阶段进度 '+i}});d({type:'message_end',message});
 }
 d({type:'tool_execution_start',toolCallId:'compact-'+i,toolName:'read',args:{path:'file-'+i}});
 d({type:'tool_execution_end',toolCallId:'compact-'+i,isError:i===2,result:{content:[{type:'text',text:'result '+i}]}});
 }
 const turn=document.querySelector('.turn');
 return {visible:turn.querySelectorAll(':scope > .tool').length, archived:turn.querySelectorAll('.tool-history .tool').length,statusAtTop:!!turn.querySelector(':scope > .turn-status'),texts:turn.querySelectorAll(':scope > .md').length,groups:[...turn.querySelectorAll('.tool-history')].map(group=>({count:group.querySelectorAll('.tool').length,afterText:group.previousElementSibling.matches('.md')})),oldLabel:turn.textContent.includes('较早的过程'),open:turn.querySelector('.tool-history').open};
 })()`);
 if(live.visible!==0||live.archived!==7||live.texts!==2||live.groups.length!==2||live.groups[0].count!==3||live.groups[1].count!==4||live.groups.some(group=>!group.afterText)||live.open||!live.statusAtTop||live.oldLabel)throw Error(JSON.stringify(live));
 const active=await evalJS(`(()=>{const d=window.__haloDispatch;d({type:'tool_execution_start',toolCallId:'active-animation',toolName:'bash',args:{command:'echo animation'}});const groups=[...document.querySelectorAll('.turn .tool-history')];return {active:groups.at(-1).classList.contains('is-running'),older:groups[0].classList.contains('is-running'),animation:getComputedStyle(groups.at(-1).querySelector('.process-label')).animationName,circle:getComputedStyle(groups.at(-1).querySelector('summary'),'::before').content,gradient:getComputedStyle(groups.at(-1).querySelector('.process-label')).backgroundImage,label:groups.at(-1).querySelector('summary').textContent};})()`);
 if(!active.active||active.older||active.animation!=='statusTextFlow'||active.circle!=='none'||!active.gradient.includes('linear-gradient')||!active.label.includes('执行中'))throw Error(JSON.stringify(active));
 await evalJS(`window.__haloDispatch({type:'tool_execution_end',toolCallId:'active-animation',result:{content:[]}})`);
 await screenshot('test/shot-progress-folds.png');
 const ended=await evalJS(`(()=>{
 const d=window.__haloDispatch;
 const message={role:'assistant',content:[{type:'text',text:'最终完成'}]};d({type:'message_start',message});d({type:'message_end',message});
 d({type:'agent_settled'});
 const turn=document.querySelector('.turn');
 return {visible:turn.querySelectorAll(':scope > .tool').length,archived:turn.querySelectorAll('.process-group .tool').length,open:turn.querySelector('.process-group').open,nested:turn.querySelectorAll('.tool-history').length,active:turn.querySelectorAll('.is-running').length,final:turn.querySelector(':scope > .md')?.textContent,progress:turn.querySelectorAll('.process-body > .md').length};
 })()`);
 if(ended.visible!==0||ended.archived!==8||ended.open||ended.nested||ended.active||ended.final!=='最终完成'||ended.progress!==2)throw Error(JSON.stringify(ended));
 console.log('PASS progress stays visible with per-stage tool folds; completion collapses progress and preserves final response');
} finally {ws.close();electron.kill();}
