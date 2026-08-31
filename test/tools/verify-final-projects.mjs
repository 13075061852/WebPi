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
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 260));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(4500);
// 启动：项目列表应含大鱼+deepagent，当前=deepagent
console.log("projects:", await ev('(async () => { const r = await window.halo.projectsList(); return JSON.stringify(r.data.map(p => ({ n: p.name, active: p.active }))); })()'));
// 新建会话 → 左侧立即显示
await ev('document.getElementById("btnNewSession").click()');
await sleep(1200);
console.log("new session in list:", await ev('JSON.stringify([...document.querySelectorAll("#sessionList .session-item .s-name")].map(e => e.textContent.trim()).slice(0, 3))'));
// 切到大鱼 → 旧会话列表显示
await ev('(async () => { const rows = [...document.querySelectorAll("#projList .proj-row")]; const row = rows.find(r => r.querySelector(".pj-name").textContent === "大鱼吃小鱼"); row.click(); })()');
await sleep(3000);
console.log("after switch to 大鱼:", await ev('JSON.stringify({ chip: document.getElementById("projectChip").textContent.trim().slice(0, 20), sessions: [...document.querySelectorAll("#sessionList .session-item .s-name")].map(e => e.textContent.trim()).slice(0, 4), projActive: (document.querySelector("#projList .proj-row.active .pj-name")||{}).textContent })'));
process.exit(0);
