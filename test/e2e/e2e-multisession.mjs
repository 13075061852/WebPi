/**
 * Multi-session E2E (real link): boots the app, sends a REAL prompt in
 * session A, switches to a NEW session WHILE A is still executing, sends
 * another prompt in B, then switches back to A and verifies:
 *  - A kept running in the background (its response is complete in the DOM)
 *  - the session list showed a "running" indicator while A was executing
 *  - both sessions coexist and switching works
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 9352;
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

let st = null;
for (let i = 0; i < 40; i++) {
  st = await evalJS("window.halo.getState().then(r => r.data)");
  if (st?.ready) break;
  await sleep(1000);
}
console.log("bridge state:", JSON.stringify({ ready: st?.ready, model: st?.model?.id }));
if (!st?.ready) throw new Error("bridge not ready");

// ---- 固定到 WebPi 项目（列表断言依赖项目目录）----
const cwd = await evalJS(`window.halo.projectsList().then(r => (r.data || []).find(p => (p.cwd || "").includes("WebPi"))?.cwd || "D:/GitHub/WebPi")`);
await evalJS(`window.halo.projectSwitch(${JSON.stringify(cwd)})`);
await sleep(2500);
console.log("switched to project:", cwd);

if (st?.model?.provider === "autoclaw" || !st?.model) {
  const r = await evalJS(`window.halo.setModel("deepseek", "deepseek-v4-flash").then(r => r.data?.model?.id)`);
  console.log("model now:", r);
}

// ---- 先开新会话，确保焦点干净（启动时恢复的上次会话不参与）----
await evalJS(`document.querySelector("#btnNewSession").click()`);
await sleep(1500);

// ---- 会话 A：发长任务（工具调用保证执行窗口），不等待完成 ----
const promptA = "请查看当前目录的 package.json，把 devDependencies 里的包名逐个列出来";
await evalJS(`(async () => {
  const input = document.querySelector("#input");
  input.value = ${JSON.stringify(promptA)};
  input.dispatchEvent(new Event("input"));
  document.querySelector("#btnSend").click();
  return true;
})()`);
console.log("A prompt sent, executing in background...");

// ---- 轮询等待左侧列表出现 running 徽标（A 需先落盘进列表，最长 90s）----
let sawBusy = false;
for (let i = 0; i < 90 && !sawBusy; i++) {
  sawBusy = await evalJS(`!!document.querySelector(".session-item .s-busy")`);
  if (!sawBusy) await sleep(1000);
}
console.log("running indicator visible in session list:", sawBusy);
if (!sawBusy) throw new Error("running indicator never appeared");

// ---- 执行中切到新会话 B（多会话核心：不应中断 A）----
await evalJS(`document.querySelector("#btnNewSession").click()`);
await sleep(1500);
const promptB = "请用一句话回答：2+2 等于几？";
await evalJS(`(async () => {
  const input = document.querySelector("#input");
  input.value = ${JSON.stringify(promptB)};
  input.dispatchEvent(new Event("input"));
  document.querySelector("#btnSend").click();
  return true;
})()`);
console.log("B prompt sent while A still running");

// ---- 等 B 完成（A 在后台，其事件被过滤，当前视图只会渲染 B）----
for (let i = 0; i < 90; i++) {
  const md = await evalJS(`!!document.querySelector("#messages .md")`);
  if (md) break;
  await sleep(1000);
}
const bText = await evalJS(`[...document.querySelectorAll("#messages .md")].map(e => e.textContent).join(" ")`);
console.log("B response:", bText.slice(0, 60));

// ---- 切回 A：验证 A 的后台任务结果完整显示 ----
const aItems = await evalJS(`[...document.querySelectorAll(".session-item")].map(i => i.querySelector(".s-name").textContent)`);
console.log("session list:", aItems.map((n) => n.slice(0, 18)));
const aIdx = await evalJS(`[...document.querySelectorAll(".session-item")].findIndex(i => (i.querySelector(".s-name").textContent || "").includes("package.json"))`);
if (aIdx < 0) throw new Error("session A not in list: " + JSON.stringify(aItems));
await evalJS(`document.querySelectorAll(".session-item")[${aIdx}].querySelector(".s-main").click()`);
await sleep(4000); // 等待恢复历史渲染

const aText = await evalJS(`[...document.querySelectorAll("#messages .md")].map(e => e.textContent).join(" ")`);
console.log("A background result rendered after switching back:", aText.slice(0, 80));
if (!aText.includes("devDependencies")) throw new Error("A result missing: " + aText.slice(0, 120));

// A 已完成后不应再有 running 徽标（B 也完成了）
const busyAfter = await evalJS(`!!document.querySelector(".session-item .s-busy")`);
console.log("no running indicator after both done:", !busyAfter);

await screenshot("test/shot-multisession.png");
console.log("MULTISESSION E2E OK");
electron.kill();
process.exit(0);
