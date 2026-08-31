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
const state = () => ev('(async () => { const r = await window.halo.getState(); return JSON.stringify(r.data ? { model: r.data.model && (r.data.model.provider + "/" + r.data.model.id) } : r); })()');
console.log("initial model:", await state());
// 找一个与当前不同的模型设为默认
const pick = await ev('(async () => {' +
  'const st = await window.halo.getState();' +
  'const cur = st.data.model ? st.data.model.provider + "/" + st.data.model.id : "";' +
  'const r = await window.halo.listModels();' +
  'const models = (r.data||[]).filter(m => !m.error);' +
  'const other = models.find(m => (m.provider + "/" + m.id) !== cur);' +
  'if (!other) return "no other model";' +
  'await window.halo.defaultModelSet(other.provider + "/" + other.id);' +
  'return JSON.stringify({ set: other.provider + "/" + other.id, was: cur });' +
'})()');
console.log("set default:", pick);
// 新会话 → 检查实际模型
console.log("newSession:", await ev('window.halo.newSession()'));
await sleep(1800);
console.log("after newSession:", await state());
// 打开一个已有会话 → 检查实际模型
const sess = await ev('(async () => { const r = await window.halo.listSessions(); return JSON.stringify((r.data||[]).slice(0,3).map(s => s.file || s.path || s)); })()');
console.log("sessions:", sess);
process.exit(0);
