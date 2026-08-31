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
await sleep(4500);
// 打开模型弹窗
console.log("open modal:", await ev('document.getElementById("btnModel").click(), "ok"'));
await sleep(1500);
const rows = await ev('JSON.stringify({ items: document.querySelectorAll("#modelList .model-item").length, defBtns: document.querySelectorAll("#modelList .mi-def").length, defOn: [...document.querySelectorAll("#modelList .mi-def.on")].map(b => b.dataset.key) })');
console.log("model modal:", rows);
// 点击第一个"设默认"
const pick = await ev('(async function(){' +
  'const btn = document.querySelector("#modelList .mi-def:not(.on)") || document.querySelector("#modelList .mi-def");' +
  'if (!btn) return "no btn";' +
  'const key = btn.dataset.key;' +
  'btn.click(); await new Promise(r => setTimeout(r, 700));' +
  'const onNow = [...document.querySelectorAll("#modelList .mi-def.on")].map(b => b.dataset.key);' +
  'return JSON.stringify({ key, onNow, saved: (await window.halo.defaultModelGet()).data });' +
'})()');
console.log("set default from modal:", pick);
// 清理
console.log("reset:", await ev('(async () => JSON.stringify(await window.halo.defaultModelSet("")))()'));
process.exit(0);
