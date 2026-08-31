/**
 * Claude-style turn rendering test:
 * boots the app, injects a realistic multi-segment turn
 * (think -> text -> tool -> think -> text -> tool -> text), then verifies
 * structure + captures a screenshot.
 */
import { writeFileSync } from "node:fs";

const PORT = process.argv[2] || "9350";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let main;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    main = list.find((t) => t.type === "page" && t.url.endsWith("index.html"));
    if (main) break;
  } catch {}
  await sleep(500);
}
if (!main) { console.log("NO WINDOW"); process.exit(1); }
console.log("connected:", main.title);

const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}
async function ev(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    console.log("PAGE EXCEPTION:", JSON.stringify(r.result.exceptionDetails, null, 2).slice(0, 800));
    return null;
  }
  return r.result?.result?.value;
}

await send("Runtime.enable");
await sleep(2500);

const inject = `(async () => {
  const d = window.__haloDispatch;
  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__renderUserMsg("帮我做一个炸弹人游戏", []);
  await sl(100);
  d({ type: "agent_start" });
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "**Inspecting current working directory**" } });
  await sl(100);
  d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好的！我先看一下项目结构，然后开始实现炸弹人游戏。" } });
  d({ type: "message_end", message: { role: "assistant", content: [], stopReason: "toolUse" } });
  d({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la && find . -maxdepth 2 -type f | head -80" } });
  await sl(150);
  d({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: { content: [{ type: "text", text: "index.html main.js" }] } });
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "**Designing complete Bomberman rewrite**" } });
  await sl(100);
  d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "index.html 已就绪，现在写入游戏主逻辑，包括：\\n\\n- 地图与墙体生成\\n- 炸弹与爆炸范围\\n- 敌人 AI" } });
  d({ type: "message_end", message: { role: "assistant", content: [], stopReason: "toolUse" } });
  d({ type: "tool_execution_start", toolCallId: "t2", toolName: "write", args: { path: "game.js" } });
  await sl(150);
  d({ type: "tool_execution_end", toolCallId: "t2", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "完成！打开预览即可游玩。" } });
  d({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "完成！打开预览即可游玩。" }], stopReason: "endTurn" } });
  d({ type: "agent_end", willRetry: false });
  d({ type: "agent_settled" });
  await sl(300);
  const turns = document.querySelectorAll("#messages > .turn");
  const think = turns[0]?.querySelector(".think");
  return JSON.stringify({
    turns: turns.length,
    heads: document.querySelectorAll(".turn-head").length,
    userBubbles: document.querySelectorAll(".bubble").length,
    mdBlocks: turns[0] ? turns[0].querySelectorAll(".md").length : 0,
    thinkCollapsed: think && !think.hasAttribute("open") ? 1 : 0,
    thinkLabel: think ? (think.querySelector(".think-label") || {}).textContent : null,
    thinkPreview: think ? (p => ({ len: p.textContent.length, hidden: getComputedStyle(p).display === "none", oneLine: getComputedStyle(p).whiteSpace === "nowrap" }))(think.querySelector(".think-preview")) : null,
    toolsDone: turns[0] ? turns[0].querySelectorAll(".tool.done").length : 0,
    strayCarets: document.querySelectorAll("#messages .caret").length,
    order: turns[0] ? [...turns[0].children].filter((e) => !e.classList.contains("turn-copy")).map((e) => e.className.split(" ")[0]).join(",") : "",
    copyBtns: turns[0] ? turns[0].querySelectorAll(".turn-copy").length : 0
  });
})()`;

const r = await ev(inject);
console.log("result:", r);

// --- streaming state: status row visible with live text, gone after settle ---
const r2 = await ev(`(async () => {
  const d = window.__haloDispatch;
  const sl = (ms) => new Promise((res) => setTimeout(res, ms));
  d({ type: "agent_start" });
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." } });
  await sl(700);
  const row = document.querySelector("#messages > .turn:last-child .turn-status");
  const during = { hidden: row.hidden, text: row.querySelector(".turn-status-text").textContent, hasOrb: !!row.querySelector(".pi-orb") };
  d({ type: "tool_execution_start", toolCallId: "t9", toolName: "bash", args: { command: "x" } });
  await sl(700);
  const duringTool = row.querySelector(".turn-status-text").textContent;
  d({ type: "tool_execution_end", toolCallId: "t9", isError: false, result: { content: [] } });
  d({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "endTurn" } });
  d({ type: "agent_end", willRetry: false });
  d({ type: "agent_settled" });
  await sl(200);
  return JSON.stringify({ during, duringTool, statusRowsAfterSettle: document.querySelectorAll(".turn-status").length, carets: document.querySelectorAll(".caret").length });
})()`);
console.log("status row:", r2);

const rr = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/shot-claude-style.png", Buffer.from(rr.result.data, "base64"));
console.log("screenshot saved: test/shot-claude-style.png");
process.exit(0);
