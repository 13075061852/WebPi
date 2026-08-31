/**
 * Real-link E2E: boots the app, drives a REAL prompt through the actual
 * bridge -> IPC -> renderer pipeline, and reports whether pi events reach
 * the DOM. Uses whatever model is available (deepseek verified working).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 9334;
const electron = spawn(
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${PORT}`],
  { stdio: ["ignore", "pipe", "pipe"] }
);
electron.stderr.on("data", () => {});
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
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
async function evalJS(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
}
async function screenshot(file) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  console.log("saved", file);
}

await send("Runtime.enable");
await send("Page.enable");

for (let i = 0; i < 30; i++) {
  try { if (await evalJS("!!window.halo && !!window.__piDebug")) break; } catch {}
  await sleep(500);
}
console.log("renderer ready");

// wait for the bridge to be ready (model resolved)
let st = null;
for (let i = 0; i < 30; i++) {
  st = await evalJS("window.halo.getState().then(r => r.data)");
  if (st?.ready) break;
  await sleep(1000);
}
console.log("bridge state:", JSON.stringify({ ready: st?.ready, model: st?.model?.id, msgs: st?.messageCount }));

// switch to a working channel if the current model is the flaky one
if (st?.model?.provider === "autoclaw" || !st?.model) {
  console.log("switching to deepseek...");
  const r = await evalJS(`window.halo.setModel("deepseek", "deepseek-v4-flash").then(r => r.data.model?.id)`);
  console.log("model now:", r);
}

// count messages DOM before
const before = await evalJS(`document.querySelectorAll("#messages > *").length`);

// ---- REAL prompt through the real pipeline ----
console.log("sending real prompt...");
const promptPromise = evalJS(`window.halo.prompt("用一句话介绍你自己，然后回复:收到").then(() => "resolved").catch(e => "rejected: " + e.message)`);

// sample the debug counters while streaming
for (let i = 0; i < 25; i++) {
  await sleep(1000);
  const dbg = await evalJS(`({count: window.__piDebug.count, last: window.__piDebug.types.slice(-4), dom: document.querySelectorAll("#messages > *").length, bubble: (document.querySelector("#messages .msg.assistant .bubble .txt")||{}).textContent?.slice(0,60)})`);
  console.log(`t+${i + 1}s events=${dbg.count} dom=${dbg.dom} bubble=${JSON.stringify(dbg.bubble)} last=[${dbg.last}]`);
  const done = await Promise.race([promptPromise.then((v) => v), sleep(50).then(() => null)]);
  if (done) { console.log("prompt:", done); break; }
}

await sleep(800);
const finalState = await evalJS("window.halo.getState().then(r => r.data)");
console.log("final:", JSON.stringify({ msgs: finalState.messageCount, usage: finalState.usage }));
await screenshot("test/shot-reallink.png");

electron.kill();
process.exit(0);
