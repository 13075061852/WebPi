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
console.log("projects:", await ev('(async () => JSON.stringify(await window.halo.projectsList()))()'));
// 切到 WebPi
console.log("switch WebPi:", await ev('(async () => { const r = await window.halo.projectSwitch("D:/GitHub/WebPi"); return JSON.stringify({ ok: r.ok, cwd: r.data && r.data.cwd, msgs: r.data && r.data.messageCount }); })()'));
await sleep(2500);
const ui1 = await ev('JSON.stringify({ tree: document.querySelectorAll("#wsTree .trow").length, chip: document.getElementById("projectChip").textContent.trim().slice(0, 30), projRows: document.querySelectorAll("#projList .proj-row").length, active: (document.querySelector("#projList .proj-row.active .pj-name")||{}).textContent })');
console.log("ui after switch:", ui1);
// 切回大鱼吃小鱼（验证 lastSession 恢复）
console.log("switch back:", await ev('(async () => { const r = await window.halo.projectSwitch("C:/Users/13087/Desktop/大鱼吃小鱼"); return JSON.stringify({ ok: r.ok, cwd: r.data && r.data.cwd, session: r.data && r.data.sessionFile }); })()'));
await sleep(2500);
const ui2 = await ev('JSON.stringify({ chip: document.getElementById("projectChip").textContent.trim().slice(0, 30), tree: document.querySelectorAll("#wsTree .trow").length })');
console.log("ui after back:", ui2);
// 移除测试项目
console.log("remove WebPi:", await ev('(async () => { const r = await window.halo.projectRemove("D:/GitHub/WebPi"); return JSON.stringify(r.data && r.data.map(p => p.name)); })()'));
process.exit(0);
