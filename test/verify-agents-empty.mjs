const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let main;
for (let i = 0; i < 40; i++) {
  try { const l = await (await fetch("http://127.0.0.1:" + PORT + "/json")).json(); main = l.find((t) => t.type === "page" && t.url.endsWith("index.html")); if (main) break; } catch {}
  await sleep(500);
}
if (!main) { console.log("NO WINDOW"); process.exit(1); }
const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => {
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(4200);
// 复位默认智能体（清除上次测试残留）
console.log("reset default:", await ev('(async () => JSON.stringify(await window.halo.agentDefaultSet("")))()'));
console.log("openSettings:", await ev('document.getElementById("btnSettings").click(), "ok"'));
await sleep(1500);
const navOk = await ev('JSON.stringify({ nav: [...document.querySelectorAll(".set-nav")].map(b => b.dataset.pane), paneActive: document.getElementById("setPane-agents").classList.contains("active") })');
console.log("nav:", navOk);
const list = await ev('JSON.stringify({ rows: document.querySelectorAll("#agentList .agent-row").length, empty: (document.querySelector("#agentList .pkg-empty")||{}).textContent || "" })');
console.log("agent pane:", list);
// 恢复存储里的 defaultAgent 为空
console.log("final default:", await ev('(async () => JSON.stringify(await window.halo.agentDefaultGet()))()'));
process.exit(0);
