/* 文件树 watcher E2E：外部（非 agent 工具链）写入/删除文件时，
 * 主进程 fs.watch → halo:tree-changed → 渲染层防抖刷新，树应自动出现/消失该文件。 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const PORT = 9337;
const PROBE = "tree-watch-probe-9337.txt";
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
  if (r.result?.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
await send("Runtime.enable");

let st = null;
for (let i = 0; i < 30; i++) {
  st = await evalJS("window.halo.getState().then(r => r.data)");
  if (st?.ready) break;
  await sleep(1000);
}
if (!st?.ready) throw new Error("bridge not ready");
console.log("cwd:", st.cwd);
const inTree = () => evalJS(`!!document.querySelector("#wsTree .trow .fname")?.textContent && [...document.querySelectorAll("#wsTree .trow .fname")].some(n => n.textContent === ${JSON.stringify(PROBE)})`);

// 外部写入文件
writeFileSync(PROBE, "probe");
console.log("probe written, waiting for watcher refresh...");
let seen = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (await inTree()) { seen = true; break; }
}
console.log("tree shows probe:", seen);
// 外部删除
rmSync(PROBE, { force: true });
console.log("probe deleted, waiting for refresh...");
let gone = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  if (!(await inTree())) { gone = true; break; }
}
console.log("tree hides probe:", gone);

electron.kill();
process.exit(seen && gone ? 0 : 1);
