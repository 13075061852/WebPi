/** Zoom-in check of collapsed thinking preview line */
import { writeFileSync } from "node:fs";
const PORT = process.argv[2] || "9360";
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
  if (r.result?.exceptionDetails) { console.log("PAGE EXCEPTION:", JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return null; }
  return r.result?.result?.value;
});

await send("Runtime.enable");
await sleep(2500);

const r = await ev(`(async () => {
  const d = window.__haloDispatch;
  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  d({ type: "agent_start" });
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "**Inspecting current working directory** and checking files" } });
  await sl(500);
  d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好的，开始实现。" } });
  d({ type: "message_end", message: { role: "assistant", content: [], stopReason: "endTurn" } });
  d({ type: "agent_end", willRetry: false });
  d({ type: "agent_settled" });
  await sl(300);
  const p = document.querySelector(".think-preview");
  const rect = p.getBoundingClientRect();
  return JSON.stringify({ text: p.textContent, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
})()`);
console.log("preview:", r);

const rect = JSON.parse(r).rect;
const rr = await send("Page.captureScreenshot", { format: "png", clip: { x: rect.x - 8, y: rect.y - 12, width: rect.w + 16, height: rect.h + 24, scale: 2.5 } });
writeFileSync("test/shot-think-preview.png", Buffer.from(rr.result.data, "base64"));
console.log("zoom screenshot saved: test/shot-think-preview.png");
process.exit(0);
