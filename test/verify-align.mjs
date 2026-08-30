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
const expr = '(() => {' +
  'const mc = document.getElementById("modelCard");' +
  'const cp = document.getElementById("composer");' +
  'const mcRect = mc.getBoundingClientRect();' +
  'const cpRect = cp.getBoundingClientRect();' +
  // 两区域顶线 y（border-top 位置）对比
  'const lineMc = mcRect.top;' +
  'const lineCp = cpRect.top;' +
  // 输入多行后再测
  'const input = document.getElementById("input");' +
  'input.value = "line1\nline2\nline3\nline4";' +
  'input.dispatchEvent(new Event("input", { bubbles: true }));' +
  'return { mcTop: Math.round(lineMc), cpTop: Math.round(lineCp), mcH: Math.round(mcRect.height), cpH: Math.round(cpRect.height) };' +
'})()';
console.log("initial:", JSON.stringify(await ev(expr)));
await sleep(600);
const expr2 = '(() => {' +
  'const mc = document.getElementById("modelCard");' +
  'const cp = document.getElementById("composer");' +
  'const r = { mcTop: Math.round(mc.getBoundingClientRect().top), cpTop: Math.round(cp.getBoundingClientRect().top), mcH: Math.round(mc.getBoundingClientRect().height), cpH: Math.round(cp.getBoundingClientRect().height) };' +
  'const input = document.getElementById("input");' +
  'input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true }));' +
  'return r;' +
'})()';
console.log("4-line :", JSON.stringify(await ev(expr2)));
await sleep(600);
const expr3 = '(() => {' +
  'const mc = document.getElementById("modelCard");' +
  'const cp = document.getElementById("composer");' +
  'return { mcTop: Math.round(mc.getBoundingClientRect().top), cpTop: Math.round(cp.getBoundingClientRect().top) };' +
'})()';
console.log("reset  :", JSON.stringify(await ev(expr3)));
process.exit(0);
