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
const evSafe = async (expression, ms = 8000) => {
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r({ timeout: true }), ms); });
  const val = await Promise.race([send("Runtime.evaluate", { expression, returnByValue: true }), timeout]);
  clearTimeout(timer);
  if (!val || val.timeout) return "EVAL-TIMEOUT";
  if (val.result?.exceptionDetails) return "PAGE-ERR: " + JSON.stringify(val.result.exceptionDetails).slice(0, 200);
  return val.result?.result?.value;
};
await send("Runtime.enable");
await sleep(4200);
console.log("set default agent:", await evSafe('(async () => JSON.stringify(await window.halo.agentDefaultSet("halo-test-agent")))()'));
await evSafe('(function(){ const inp = document.getElementById("input"); inp.value = "用一句话自我介绍"; })()');
await evSafe('document.getElementById("btnSend").click(), "clicked"');
let lastLen = -1, stable = 0;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const len = await evSafe('(document.getElementById("messages")||{innerText:""}).innerText.length');
  if (len === "EVAL-TIMEOUT") { console.log("eval timeout at", i); continue; }
  if (len > 0 && len === lastLen) { stable++; if (stable >= 3) break; } else stable = 0;
  lastLen = len;
  if (i % 10 === 0) console.log("poll", i, "len", len);
}
const txt = await evSafe('(() => { const el = document.getElementById("messages"); return el ? el.innerText.slice(-400) : ""; })()');
console.log("reply:", JSON.stringify(txt));
process.exit(0);
