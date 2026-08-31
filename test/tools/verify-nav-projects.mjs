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
const ui = await ev('JSON.stringify({' +
  ' navTabs: [...document.querySelectorAll(".nav-item span")].map(e => e.textContent),' +
  ' quickGone: !document.querySelector(".quick-list"),' +
  ' projInChat: !!document.querySelector("[data-pane=chat] #projList"),' +
  ' projRows: [...document.querySelectorAll("#projList .proj-row .pj-name")].map(e => e.textContent),' +
  ' sessionsTab: [...document.querySelectorAll("#sessionList .session-item .s-name")].map(e => e.textContent).slice(0, 2)' +
'})');
console.log(ui);
process.exit(0);
