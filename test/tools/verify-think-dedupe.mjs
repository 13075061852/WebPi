/* 验证：思考块不重复
 * 场景A：流式发过 thinking_delta → 消息结束时不应再恢复第二个思考块
 * 场景B：完全没流式发思考 → 兜底恢复仍应生效（1 个思考块，标签“思考过程”）
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let main;
for (let i = 0; i < 40; i++) {
  try { const l = await (await fetch("http://127.0.0.1:9371/json")).json(); main = l.find((t) => t.type === "page" && t.url.endsWith("index.html")); if (main) break; } catch {}
  await sleep(500);
}
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => {
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 260));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(2500);

const THINK = "The user says 晚上好 (Good evening) in Chinese. This is a simple greeting, respond briefly.";
const ANSWER = "晚上好！有什么我可以帮你的吗？";

// 场景A：流式思考 + 正文 + 最终消息（含思考）
await ev(`(async () => {
  window.__haloDispatch({ type: "agent_start" });
  window.__haloDispatch({ type: "message_start", message: { role: "assistant" } });
  window.__haloDispatch({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: ${JSON.stringify(THINK)} } });
  window.__haloDispatch({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ${JSON.stringify(ANSWER)} } });
  window.__haloDispatch({ type: "message_end", message: { role: "assistant", content: [ { type: "thinking", thinking: ${JSON.stringify(THINK)} }, { type: "text", text: ${JSON.stringify(ANSWER)} } ] } });
  window.__haloDispatch({ type: "agent_end" });
  return true;
})()`);
await sleep(400);
console.log("场景A（流式思考）:", await ev(`JSON.stringify({
  thinkBlocks: document.querySelectorAll("#messages .think").length,
  labels: [...document.querySelectorAll("#messages .think .think-label")].map(x => x.textContent.trim()),
  answer: document.querySelector("#messages .md")?.textContent.slice(0, 20)
})`));

// 清空聊天，测场景B
await ev(`document.getElementById("messages").innerHTML = ""; true`);
await ev(`(async () => {
  window.__haloDispatch({ type: "agent_start" });
  window.__haloDispatch({ type: "message_start", message: { role: "assistant" } });
  window.__haloDispatch({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ${JSON.stringify(ANSWER)} } });
  window.__haloDispatch({ type: "message_end", message: { role: "assistant", content: [ { type: "thinking", thinking: ${JSON.stringify(THINK)} }, { type: "text", text: ${JSON.stringify(ANSWER)} } ] } });
  window.__haloDispatch({ type: "agent_end" });
  return true;
})()`);
await sleep(400);
console.log("场景B（无流式思考，兜底恢复）:", await ev(`JSON.stringify({
  thinkBlocks: document.querySelectorAll("#messages .think").length,
  labels: [...document.querySelectorAll("#messages .think .think-label")].map(x => x.textContent.trim()),
  thinkBody: document.querySelector("#messages .think .think-body")?.textContent.slice(0, 30)
})`));

process.exit(0);
