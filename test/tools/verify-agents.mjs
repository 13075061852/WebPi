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
await sleep(3500);
console.log("openSettings:", await ev('document.getElementById("btnSettings").click(), "ok"'));
await sleep(1500);
const list = await ev('JSON.stringify([...document.querySelectorAll("#agentList .agent-row")].map(r => ({ n: r.dataset.name, on: r.classList.contains("on") })))');
console.log("agent rows:", list);
// 选择 halo-test-agent
const pick = await ev('(async function(){' +
  'const row = [...document.querySelectorAll("#agentList .agent-row")].find(r => r.dataset.name === "halo-test-agent");' +
  'if (!row) return "row missing";' +
  'row.click(); await new Promise(r => setTimeout(r, 600));' +
  'return JSON.stringify({ on: row.classList.contains("on") });' +
'})()');
console.log("pick:", pick);
// store 持久化验证
const saved = await ev('(async function(){ const r = await window.halo.agentDefaultGet(); return JSON.stringify(r); })()');
console.log("defaultAgent saved:", saved);
// 恢复默认
const reset = await ev('(async function(){' +
  'const row = document.querySelector("#agentList .agent-row[data-name=' + "''" + ']");' +
  'if (!row) return "default row missing";' +
  'row.click(); await new Promise(r => setTimeout(r, 600));' +
  'return "reset";' +
'})()');
console.log("reset:", reset);
process.exit(0);
