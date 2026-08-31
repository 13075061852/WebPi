import path from "node:path";
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
await sleep(3000);
const norm = (p) => String(p || "").split(path.sep).join("/").replace(/\/$/, "").toLowerCase();

// 1. 当前状态 + localStorage 自动保存检查
const s1 = await ev("window.halo.getState().then((r) => r.data || r)");
const saved1 = await ev("localStorage.getItem('halo-workspace')");
console.log("state.cwd =", s1.cwd);
console.log("state.sessionFile =", path.basename(s1.sessionFile || ""));
console.log("auto-saved =", saved1);

// 2. 找一个不同的会话（或新建）
const sessions = await ev("window.halo.listSessions().then((r) => r.data)");
let target = (sessions || []).find((s) => norm(s.file) !== norm(s1.sessionFile));
if (!target) {
  console.log("only one session — creating another");
  await ev("window.halo.newSession()");
  await sleep(1200);
  const s2 = await ev("window.halo.getState().then((r) => r.data || r)");
  const list2 = await ev("window.halo.listSessions().then((r) => r.data)");
  target = (list2 || []).find((s) => norm(s.file) !== norm(s2.sessionFile));
}
if (!target) { console.log("STILL NO SECOND SESSION — skip restore test"); process.exit(0); }
console.log("target session =", path.basename(target.file || ""));

// 3. 模拟"关闭前打开的是 target 会话"：写记忆，然后 reload（重启恢复流程）
const savedObj = { cwd: s1.cwd.split(path.sep).join("/"), session: target.file.split(path.sep).join("/") };
await ev("localStorage.setItem('halo-workspace', JSON.stringify(" + JSON.stringify(JSON.stringify(savedObj)) + "))");
await send("Page.reload");
await sleep(4500);

// 4. reload 后应自动恢复到 target 会话
const s3 = await ev("window.halo.getState().then((r) => r.data || r)");
const ok = norm(s3.sessionFile) === norm(target.file.split(path.sep).join("/"));
console.log("restored sessionFile =", path.basename(s3.sessionFile || ""));
console.log(ok ? "✅ 恢复成功：与关闭前一致" : "❌ 恢复失败");
// 5. turn-copy 不存在检查
const copyBtn = await ev("document.querySelectorAll('.turn-copy').length");
console.log("turn-copy buttons =", copyBtn, copyBtn === 0 ? "✅" : "❌");
process.exit(0);
