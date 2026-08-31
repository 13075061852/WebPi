/**
 * E2E render test: boots the real Electron app, then injects synthetic
 * pi event streams through window.__haloDispatch and captures screenshots.
 * Verifies the full renderer pipeline without depending on network/model access.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = 9333;
const electron = spawn(
  process.platform === "win32" ? "node_modules/electron/dist/electron.exe" : "node_modules/.bin/electron",
  [".", `--remote-debugging-port=${PORT}`],
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

// ---- Scenario A: happy path with tool call, streaming, queue chip ----
await evalJS(`(async () => {
  const d = window.__haloDispatch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  d({ type: "agent_start" });
  await sleep(250);
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  for (const ch of ["用户想让我了解项目。", "先查看目录结构。"]) {
    d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: ch } });
    await sleep(120);
  }
  const text = "我先看一下项目的目录结构，再决定怎么做。";
  for (const w of text.split("")) {
    d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: w } });
    if (Math.random() < 0.2) await sleep(25);
  }
  d({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "toolUse" } });
  await sleep(200);
  d({ type: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: { path: "." } });
  await sleep(700);
  d({ type: "tool_execution_update", toolCallId: "t1", partial: { args: { path: "." } } });
  d({ type: "tool_execution_end", toolCallId: "t1", isError: false,
      result: { content: [{ type: "text", text: "src/\\nassets/\\npackage.json\\nREADME.md\\nOPTIMIZATIONS.md" }] } });
  await sleep(250);
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  const t2 = "**项目结构** 很清晰：\\n\\n- src/ —— 主进程与渲染层\\n- assets/ —— 图标资源\\n\\n需要我继续优化 UI 吗？";
  let buf = "";
  for (const w of t2.split("")) {
    buf += w;
    d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: w } });
    await sleep(12);
  }
  d({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: t2 }],
      stopReason: "endTurn", usage: { input: 1200, output: 340, cacheRead: 8200, cacheWrite: 260, cost: { total: 0.0123 } } } });
  d({ type: "agent_end", messages: [], willRetry: false });
  d({ type: "agent_settled" });
  d({ type: "queue_update", steering: ["把发送按钮改成渐变色"], followUp: [] });
})()`);
await sleep(600);
await screenshot("test/shot-happy.png");

// ---- DOM 结构断言（不只截图，验证渲染结果） ----
const domCheck = await evalJS(`({
  turns: document.querySelectorAll("#messages > .turn").length,
  mdText: [...document.querySelectorAll("#messages .md")].map(n => n.textContent).join("|"),
  hasBold: !!document.querySelector("#messages .md b"),
  toolCards: document.querySelectorAll("#messages .tool").length,
  toolDone: !!document.querySelector("#messages .tool.done"),
  queueChips: document.querySelectorAll("#queueRow .queue-chip").length,
  stats: document.querySelector("#chatStats")?.textContent || "",
})`);
console.log("dom check:", JSON.stringify(domCheck));
if (!domCheck.turns || !domCheck.mdText.includes("项目结构") || !domCheck.hasBold || !domCheck.toolCards || !domCheck.toolDone || !domCheck.queueChips || !domCheck.stats) {
  console.log("DOM VERIFY FAILED");
  electron.kill();
  process.exit(1);
}
console.log("DOM VERIFY OK");

// ---- Scenario B: error path with retry ----
await evalJS(`(async () => {
  const d = window.__haloDispatch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  d({ type: "agent_start" });
  await sleep(200);
  const em = '429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}';
  d({ type: "message_start", message: { role: "assistant", content: [], provider: "zai-coding-cn", model: "glm-5.3-flash", stopReason: "error", errorMessage: em } });
  d({ type: "message_end", message: { role: "assistant", content: [], provider: "zai-coding-cn", model: "glm-5.3-flash", stopReason: "error", errorMessage: em } });
  d({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: em });
  d({ type: "agent_end", messages: [], willRetry: true });
})()`);
await sleep(500);
await screenshot("test/shot-error.png");

// ---- zoom clamp sanity（nebula.js 已于 4c0d779 移除，画布不再存在于 UI 中，跳过） ----

console.log("console errors during test:", consoleLogs.length ? consoleLogs : "none");

ws.close();
electron.kill();
process.exit(0);
