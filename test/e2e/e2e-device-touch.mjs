/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 9398;
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
  await sleep(1400);
  await evalJS("document.querySelector('#pvBody').innerHTML='<div class=dev-shell><div class=dev-screen><iframe src=about:blank></iframe></div></div>'");
  const sizes=[];
  for (const device of ['desktop','tablet','mobile','desktop','mobile']) {
    await evalJS(`document.querySelector('.pvdev[data-dev="${device}"]').click()`);
    await sleep(650);
    sizes.push(await evalJS(`(()=>{const frame=document.querySelector('#pvBody iframe'),r=frame.getBoundingClientRect();return {device:'${device}',width:r.width,viewport:frame.contentWindow.innerWidth,chat:document.querySelector('#chat').getBoundingClientRect().width};})()`));
  }
  if(sizes.some(s=>s.width<=0||Math.abs(s.width-s.viewport)>2||s.chat<479))throw Error(JSON.stringify(sizes));
  const tree=await send('Page.getFrameTree');
  const frameId=tree.result.frameTree.childFrames[0].frame.id;
  const world=await send('Page.createIsolatedWorld',{frameId,worldName:'touch-test'});
  const contextId=world.result.executionContextId;
  const inFrame=async expression=>{const r=await send('Runtime.evaluate',{expression,contextId,awaitPromise:true,returnByValue:true});if(r.result.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result.result.value;};
  await inFrame("document.body.innerHTML='<div id=surface style=height:3000px;background:linear-gradient(white,blue)>Drag surface</div>';document.body.style.margin='0'");
  await inFrame(readFileSync('src/main/inject/touch-on.js','utf8'));
  const drag = await inFrame(`(async()=>{const surface=document.querySelector('#surface');const event=(type,y)=>surface.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,button:0,clientX:50,clientY:y}));event('pointerdown',300);event('pointermove',100);await new Promise(r=>setTimeout(r,60));const y=scrollY;event('pointerup',100);return {y,cursor:getComputedStyle(document.documentElement).cursor};})()`);
  if(drag.y<150||!drag.cursor.includes('data:image/svg+xml'))throw Error('Touch drag failed '+JSON.stringify(drag));
  await inFrame(readFileSync('src/main/inject/touch-off.js','utf8'));
  const stopped=await inFrame('({home:!!document.getElementById("__halo-home"),on:window.__haloTouchOn,drag:document.documentElement.classList.contains("halo-drag")})');
  if(stopped.on||stopped.drag||stopped.home)throw Error('Touch disable failed');
  console.log('PASS device widths and chat minimum',JSON.stringify(sizes));
  console.log('PASS simulated finger drag and dot cursor',JSON.stringify(drag));
} finally {ws.close();electron.kill();}
