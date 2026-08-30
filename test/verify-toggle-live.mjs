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
// 打开设置面板
console.log("openSettings:", await ev('typeof window.halo !== "undefined" ? "halo ok" : "NO halo"'));
await ev('document.getElementById("btnSettings") && document.getElementById("btnSettings").click()');
await sleep(1500);
// 已安装 tab 状态
const before = await ev('(function(){' +
  'const rows = [...document.querySelectorAll("#pkgInstalled .pkg-row")];' +
  'return JSON.stringify({ rows: rows.length, states: rows.map(r => ({ name: r.querySelector(".pkg-name").textContent, on: r.querySelector(".ext-switch").classList.contains("on"), i: r.dataset.i })) });' +
'})()');
console.log("before:", before);
// 点击第一个开关（停用 pi-wechat-assistant）
const clickResult = await ev('(async function(){' +
  'const sw = document.querySelector("#pkgInstalled .pkg-row .ext-switch");' +
  'if (!sw) return "no switch";' +
  'sw.click();' +
  'await new Promise(r => setTimeout(r, 1800));' +
  'const row = sw.closest(".pkg-row");' +
  'return JSON.stringify({ afterClick_on: sw.classList.contains("on"), rowOff: row.classList.contains("off") });' +
'})()');
console.log("after click:", clickResult);
// 直接调 IPC 看 r 值
const direct = await ev('(async function(){' +
  'const r = await window.halo.pkgToggle("npm:pi-web-access", false);' +
  'return JSON.stringify(r);' +
'})()');
console.log("direct pkgToggle:", direct);
await sleep(600);
// 读 settings.json 状态
const st = await ev('(async function(){' +
  'const r = await window.halo.pkgInstalled();' +
  'return JSON.stringify((r.data||[]).map(p => p.raw + ":" + p.disabled));' +
'})()');
console.log("installed disabled map:", st);
process.exit(0);
