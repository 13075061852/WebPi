/**
 * Workspace/Preview E2E: drives a REAL prompt asking the agent to create an
 * HTML page, then verifies auto-preview switch, file tree, session activity.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 9335;
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
let st = null;
for (let i = 0; i < 30; i++) {
  st = await evalJS("window.halo.getState().then(r => r.data)");
  if (st?.ready) break;
  await sleep(1000);
}
console.log("bridge:", JSON.stringify({ ready: st?.ready, model: st?.model?.id }));
await evalJS(`window.halo.setModel("deepseek", "deepseek-v4-flash")`);

// 先开新会话，避免上次会话上下文污染（多会话改造后恢复会话可能带旧任务）
await evalJS(`document.querySelector("#btnNewSession").click()`);
await sleep(1500);

console.log("prompting agent to create an HTML page...");
const p = evalJS(`window.halo.prompt("在当前目录创建 hello.html：一个居中显示的深色问候页面，标题'你好，星环'，副标题'由 pi Halo 生成'，带渐变文字动画。创建完成后回复完成。").then(() => "resolved").catch(e => "rejected: " + e.message)`);

let done = null;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  done = await Promise.race([p.catch(() => "err"), sleep(30).then(() => null)]);
  if (done) { console.log(`t+${i + 1}s prompt:`, done); break; }
  if (i % 10 === 9) {
    const dbg = await evalJS(`({events: window.__piDebug.count, preview: document.querySelector("#pvName")?.textContent, active: document.querySelector(".ctab.active")?.textContent})`);
    console.log(`t+${i + 1}s`, JSON.stringify(dbg));
  }
}
await sleep(2500);

// verify: preview auto-switched, tree loaded, changed markers present
const check = await evalJS(`({
  pvName: document.querySelector("#pvName")?.textContent,
  iframe: !!document.querySelector("#pvBody iframe"),
  treeRows: document.querySelectorAll("#wsTree .trow").length,
  changedRows: document.querySelectorAll("#wsTree .trow.changed").length,
})`);
console.log("verify:", JSON.stringify(check));
await screenshot("test/shot-autopreview.png");

// screenshot the sidebar file tree (workspace tree lives in the sidebar since the UI restructure)
await evalJS(`document.querySelector("#btnSidebar")?.click()`);
await sleep(800);
await screenshot("test/shot-workspace.png");

electron.kill();
process.exit(0);
