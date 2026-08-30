/* 验证：工具执行期间（streamingTool 非空）停滞看门狗不再误报“网关无响应”
 * 场景A：web_search 执行 25s 无事件 → 不应出现 stall-hint
 * 场景B：无工具在跑时 11s 无事件 → 仍应出现 stall-hint（保留真实卡顿警告）
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
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(2500);

console.log("== 场景A：工具执行 25s 静默 ==");
await ev(`(async () => {
  document.getElementById("messages").innerHTML = "";
  window.__haloDispatch({ type: "agent_start" });
  window.__haloDispatch({ type: "tool_execution_start", toolCallId: "t1", toolName: "web_search", args: { queries: ["test"] } });
  return true;
})()`);
await sleep(25000);
console.log("stall-hint 出现次数（应为 0）:", await ev(`document.querySelectorAll("#messages .stall-hint").length`));

console.log("== 场景B：无工具，11s 静默 ==");
await ev(`(async () => {
  window.__haloDispatch({ type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "ok" }] } });
  return true;
})()`);
await sleep(12000);
console.log("stall-hint 出现（应有，文本如下）:", await ev(`JSON.stringify([...document.querySelectorAll("#messages .stall-hint")].map(x => x.textContent.trim()))`));

process.exit(0);
