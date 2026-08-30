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
console.log("openSettings:", await ev('document.getElementById("btnSettings").click(), "ok"'));
await sleep(1800);
// 切到模型与登录 pane
await ev('document.querySelector(".set-nav[data-pane=login]").click()');
await sleep(1500);
const info = await ev('JSON.stringify({ defName: document.getElementById("defModelName").textContent, groups: document.querySelectorAll("#defModelList .model-group-label").length, rows: document.querySelectorAll("#defModelList .agent-row").length, firstRow: (document.querySelector("#defModelList .agent-row .pkg-name")||{}).textContent })');
console.log("login pane:", info);
// 选择第一个模型为默认
const pick = await ev('(async function(){' +
  'const row = document.querySelector("#defModelList .agent-row");' +
  'if (!row) return "no row";' +
  'const key = row.dataset.key;' +
  'row.click(); await new Promise(r => setTimeout(r, 600));' +
  'return JSON.stringify({ key, on: row.classList.contains("on"), saved: (await window.halo.defaultModelGet()).data });' +
'})()');
console.log("pick:", pick);
// 清理：恢复为空
console.log("reset:", await ev('(async () => JSON.stringify(await window.halo.defaultModelSet("")))()'));
process.exit(0);
