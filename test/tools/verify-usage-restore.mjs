/* 验证：切换会话后顶部 tokens 统计应恢复该会话的真实累计值 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let main;
for (let i = 0; i < 40; i++) {
  try { const l = await (await fetch("http://127.0.0.1:9371/json")).json(); main = l.find((t) => t.type === "page" && t.url.endsWith("index.html")); if (main) break; } catch {}
  await sleep(500);
}
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
await sleep(2500);

const baseName = (p) => String(p || "").split(/[\\/]/).pop();
const fmt = (u) => `in=${u.input} out=${u.output} R=${u.cacheRead} W=${u.cacheWrite} cost=$${(u.cost || 0).toFixed(4)}`;

console.log("== 1) 切换到消息最多的会话（40条） ==");
console.log(await ev(`(async () => {
  const r = await window.halo.listSessions();
  const s = (r.data || []).slice().sort((a,b)=>(b.messageCount||0)-(a.messageCount||0))[0];
  const sw = await window.halo.openSession(s.file);
  const st = (await window.halo.getState()).data;
  return JSON.stringify({
    session: ${baseName.toString()}.slice(0,0) + (s.file||"").split(/[\\\\/]/).pop().slice(0,28),
    msgs: st.messageCount,
    usage: st.usage,
    statsText: document.getElementById("chatStats").innerText.replace(/\\n/g, " ")
  });
})()`));

console.log("== 2) 再切到另一个会话（28条） ==");
console.log(await ev(`(async () => {
  const r = await window.halo.listSessions();
  const list = (r.data || []).slice().sort((a,b)=>(b.messageCount||0)-(a.messageCount||0));
  const s = list[1];
  const sw = await window.halo.openSession(s.file);
  const st = (await window.halo.getState()).data;
  return JSON.stringify({
    msgs: st.messageCount,
    usage: st.usage,
    statsText: document.getElementById("chatStats").innerText.replace(/\\n/g, " ")
  });
})()`));

console.log("== 3) 新会话（应为 0/占位符） ==");
console.log(await ev(`(async () => {
  const sw = await window.halo.newSession();
  const st = (await window.halo.getState()).data;
  return JSON.stringify({
    msgs: st.messageCount,
    usage: st.usage,
    statsText: document.getElementById("chatStats").innerText.replace(/\\n/g, " ")
  });
})()`));

process.exit(0);
