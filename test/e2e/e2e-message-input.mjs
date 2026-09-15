/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 9370;
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
 for (const withImage of [false,true]) {
  const content=[{type:'text',text:'hello regression'}];
  if(withImage) content.push({type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='});
  await evalJS('window.__haloRestoreView('+JSON.stringify({state:{ready:true,isStreaming:false,sessionId:'send-regression'},seq:0,messages:[{role:'user',content}]})+')');
  if(!await evalJS(`document.querySelector('.msg.user .bubble')?.textContent.includes('hello regression')`)) throw new Error('User text failed');
  if(withImage) {
   await evalJS('window.__renderUserMsg("image regression",'+JSON.stringify([{name:'shot.png',mediaType:'image/png',data:content[1].data}])+')');
   await evalJS(`document.querySelector('.msg.user .imgs img').click()`);
   if(!await evalJS(`!!document.querySelector('.image-viewer[open]')`))throw new Error('Image preview failed');
   await evalJS(`document.querySelector('.image-viewer button').click()`);
  }
 }
 // Actual live events must render accepted normal/queued user messages exactly once,
 // including identical consecutive text, and separate their answer turns.
 await evalJS('window.__haloRestoreView('+JSON.stringify({state:{ready:true,isStreaming:false,sessionId:'live-user-regression'},seq:0,messages:[]})+')');
 await evalJS(`(() => {
   const dispatch = event => window.__haloDispatch(event, 'live-user-regression');
   dispatch({type:'agent_start'});
   for (let index = 0; index < 3; index++) {
     const content = [{type:'text',text:'相同的追问'}];
     if (index === 2) content.push({type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='});
     const user = {role:'user',content,timestamp:Date.now()+index};
     dispatch({type:'message_start',message:user});
     dispatch({type:'message_end',message:user});
     dispatch({type:'message_start',message:{role:'assistant',content:[]}});
     dispatch({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'回答 '+index}});
     const assistant = {role:'assistant',content:[{type:'text',text:'回答 '+index}]};
     dispatch({type:'message_end',message:assistant});
     dispatch({type:'turn_end',message:assistant});
   }
   dispatch({type:'agent_end',messages:[],willRetry:false});
   dispatch({type:'agent_settled'});
 })()`);
 const live = await evalJS(`({
   users:document.querySelectorAll('#messages > .msg.user').length,
   turns:document.querySelectorAll('#messages > .turn.complete').length,
   images:document.querySelectorAll('#messages > .msg.user .imgs img').length,
   text:[...document.querySelectorAll('#messages > .msg.user .bubble')].map(node=>node.textContent.trim()),
   order:[...document.querySelectorAll('#messages > .msg.user, #messages > .turn')].map(node=>node.classList.contains('user')?'user':'answer')
 })`);
 if(live.users !== 3 || live.turns !== 3 || live.images !== 1 || live.text.some(text=>text !== '相同的追问') || live.order.join(',') !== 'user,answer,user,answer,user,answer') {
   throw Error('Live user/queued turn rendering failed: '+JSON.stringify(live));
 }
 await evalJS(`document.querySelector('#input').value='/help';document.querySelector('#btnSend').click()`);
 await sleep(150);
 if(!await evalJS(`document.querySelector('#helpModal').classList.contains('show')`))throw new Error('Send button failed');
 console.log('PASS text/image history, accepted live/queued messages, repeated text, answer separation, image preview and send button');
} finally { ws.close(); electron.kill(); }
