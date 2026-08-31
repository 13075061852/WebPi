/* usageSummary 流式实现冒烟：真实 app 内调用，验证 readline 路径产出聚合数据 */
import { spawn } from "node:child_process";

const PORT = 9338;
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
  if (r.result?.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
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
const r = await evalJS(`window.halo.usageSummary(30).then(r => ({
  ok: r.ok,
  sessions: r.data?.sessions,
  totals: r.data?.totals && { calls: r.data.totals.calls, tokens: r.data.totals.totalTokens, cost: r.data.totals.cost },
  models: (r.data?.models || []).length,
  daily: (r.data?.daily || []).length,
  projects: (r.data?.projects || []).length,
  error: r.error
}))`);
console.log("usageSummary:", JSON.stringify(r));
const sane = r.ok && typeof r.sessions === "number" && r.totals && typeof r.totals.calls === "number" && r.error === undefined;
electron.kill();
console.log(sane ? "USAGE SUMMARY OK" : "USAGE SUMMARY FAILED");
process.exit(sane ? 0 : 1);
