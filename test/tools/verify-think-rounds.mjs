/** Faithful multi-round thinking+tool simulation; inspect each .think block state */
import { writeFileSync } from "node:fs";
const PORT = process.argv[2] || "9368";
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

const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => {
  if (r.result?.exceptionDetails) { console.log("PAGE EXCEPTION:", JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return null; }
  return r.result?.result?.value;
});

await send("Runtime.enable");
await sleep(2500);

const r = await ev(`(async () => {
  const d = window.__haloDispatch;
  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  // 真实流：工具轮之间只有 message_start，不触发 message_end
  d({ type: "agent_start" });
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Listing project files for inspection" } });
  await sl(600);
  d({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  await sl(300);
  d({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: { content: [{ type: "text", text: "index.html" }] } });
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Inspecting Tetris codebase" } });
  await sl(600);
  d({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "index.html" } });
  await sl(300);
  d({ type: "tool_execution_end", toolCallId: "t2", isError: false, result: { content: [{ type: "text", text: "..." }] } });
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Diagnosing layout clipping" } });
  await sl(500);
  d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "检查完毕。" } });
  d({ type: "message_end", message: { role: "assistant", stopReason: "endTurn", content: [] } });
  d({ type: "agent_end", willRetry: false });
  d({ type: "agent_settled" });
  await sl(300);
  return JSON.stringify([...document.querySelectorAll("#messages .think")].map((t) => ({
    open: t.hasAttribute("open"),
    label: t.querySelector(".think-label").textContent,
    preview: t.querySelector(".think-preview").textContent.slice(0, 40),
  })));
})()`);
console.log("think blocks:", r);
const rr = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/shot-think-rounds.png", Buffer.from(rr.result.data, "base64"));
process.exit(0);
