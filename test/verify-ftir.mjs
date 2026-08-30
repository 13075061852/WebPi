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
// 启动时 cwd=FTIR（store），文件树应显示 FTIR 内容
console.log("boot:", await ev('JSON.stringify({ wsPath: document.getElementById("wsPath").textContent, treeRows: document.querySelectorAll("#wsTree .trow").length, projRows: [...document.querySelectorAll("#projList .proj-row .pj-name")].map(e => e.textContent) })'));
// 切到 FTIR（项目行点击路径）——防御补录验证：先移除 FTIR 再切（应自动补录）
await ev('(async () => { await window.halo.projectRemove("D:/GitHub/FTIR"); })()');
console.log("removed FTIR, now switch:", await ev('(async () => { const t = Date.now(); const r = await window.halo.projectSwitch("D:/GitHub/FTIR"); return JSON.stringify({ ok: r.ok, ms: Date.now() - t }); })()'));
await sleep(2000);
console.log("after switch:", await ev('JSON.stringify({ wsPath: document.getElementById("wsPath").textContent, treeRows: document.querySelectorAll("#wsTree .trow").length, projRows: [...document.querySelectorAll("#projList .proj-row .pj-name")].map(e => e.textContent) })'));
process.exit(0);
