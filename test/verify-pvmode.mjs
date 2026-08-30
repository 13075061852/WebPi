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
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 240));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(3200);

// 打开 index.html（渲染模式默认）
const open = '(() => { const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname") && /^(index|tetris)\.html$/.test(e.querySelector(".fname").textContent)); if (!row) return "NOT FOUND"; row.click(); return "ok"; })()';
console.log("open:", await ev(open));
await sleep(1200);
const r1 = await ev('({ modeHidden: document.getElementById("pvMode").hidden, iframe: !!document.querySelector("#pvBody iframe"), fvCode: !!document.querySelector("#pvBody .fv-code") })');
console.log("1. render mode:", JSON.stringify(r1));

// 切到源码
await ev('[...document.querySelectorAll("#pvMode button")].find((b) => b.dataset.m === "source").click()');
await sleep(900);
const r2 = await ev('({ iframe: !!document.querySelector("#pvBody iframe"), fvCode: !!document.querySelector("#pvBody .fv-code"), hlSpans: document.querySelectorAll("#pvBody .fvc-body span[class^=c-]").length, lnRows: document.querySelectorAll("#pvBody .fvc-ln") ? (document.querySelector("#pvBody .fvc-ln")?.textContent.split("\n").length || 0) : 0, tagColored: !!document.querySelector("#pvBody .fvc-body .c-str"), first120: (document.querySelector("#pvBody .fvc-body")?.textContent || "").slice(0, 80).replace(/\n/g, " ") })');
console.log("2. source mode:", JSON.stringify(r2));

// 切回渲染
await ev('[...document.querySelectorAll("#pvMode button")].find((b) => b.dataset.m === "render").click()');
await sleep(900);
const r3 = await ev('({ iframe: !!document.querySelector("#pvBody iframe"), fvCode: !!document.querySelector("#pvBody .fv-code") })');
console.log("3. back to render:", JSON.stringify(r3));

// 切到 py 文件：pvMode 应隐藏
await ev('(() => { const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname") && e.querySelector(".fname").textContent.endsWith(".py")); if (row) row.click(); })()');
await sleep(800);
const r4 = await ev('({ modeHidden: document.getElementById("pvMode").hidden, fvCode: !!document.querySelector("#pvBody .fv-code") })');
console.log("4. py file:", JSON.stringify(r4));
process.exit(0);
