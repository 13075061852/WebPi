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
await ev('document.getElementById("btnSettings") && document.getElementById("btnSettings").click()');
await sleep(1500);
// 记录开关元素引用，点击后检查同一元素（未被替换 = 无重绘）
const r1 = await ev('(async function(){' +
  'const sw = document.querySelector("#pkgInstalled .pkg-row .ext-switch");' +
  'const row = sw.closest(".pkg-row");' +
  'sw.click();' +
  'await new Promise(r => setTimeout(r, 1200));' +
  'const swAfter = row.querySelector(".ext-switch");' +
  'return JSON.stringify({' +
  ' sameNode: sw === swAfter,' +
  ' nowOn: swAfter.classList.contains("on"),' +
  ' rowOff: row.classList.contains("off"),' +
  ' badge: !!row.querySelector(".pkg-off-badge"),' +
  ' badgeText: (row.querySelector(".pkg-off-badge")||{}).textContent || ""' +
  '});})()');
console.log("toggle off in place:", r1);
// 再点一次恢复
const r2 = await ev('(async function(){' +
  'const sw = document.querySelector("#pkgInstalled .pkg-row:nth-child(1) .ext-switch");' +
  'sw.click();' +
  'await new Promise(r => setTimeout(r, 1200));' +
  'const row = sw.closest(".pkg-row");' +
  'return JSON.stringify({ nowOn: sw.classList.contains("on"), rowOff: row.classList.contains("off"), badge: !!row.querySelector(".pkg-off-badge") });' +
'})()');
console.log("toggle on in place:", r2);
// 行数与索引完整性
const r3 = await ev('JSON.stringify({ rows: document.querySelectorAll("#pkgInstalled .pkg-row").length, idx: [...document.querySelectorAll("#pkgInstalled .pkg-row")].map(r=>r.dataset.i).join(",") })');
console.log("rows intact:", r3);
process.exit(0);
