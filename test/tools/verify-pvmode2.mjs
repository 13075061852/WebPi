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
console.log("open:", await ev('(() => { const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname") && /^(index|tetris)[.]html$/.test(e.querySelector(".fname").textContent)); if (!row) return "NOT FOUND"; row.click(); return "ok"; })()'));
await sleep(1200);
// 点「源码」
console.log("click source:", await ev('document.querySelector("#pvMode [data-m=source]").click(), "ok"'));
await sleep(1000);
console.log("source mode:", JSON.stringify(await ev('JSON.stringify({ iframe: !!document.querySelector("#pvBody iframe"), fvCode: !!document.querySelector("#pvBody .fv-code"), hlSpans: document.querySelectorAll("#pvBody .fvc-body span[class^=c-]").length, lnRows: (document.querySelector("#pvBody .fvc-ln") ? document.querySelector("#pvBody .fvc-ln").textContent.split(String.fromCharCode(10)).length : 0), strColored: !!document.querySelector("#pvBody .fvc-body .c-str"), kwColored: !!document.querySelector("#pvBody .fvc-body .c-kw"), head: (document.querySelector("#pvBody .fvc-body") ? document.querySelector("#pvBody .fvc-body").textContent.slice(0, 60) : "").split(String.fromCharCode(10))[0] })')));
// 切回渲染
console.log("click render:", await ev('document.querySelector("#pvMode [data-m=render]").click(), "ok"'));
await sleep(1000);
console.log("render back:", JSON.stringify(await ev('JSON.stringify({ iframe: !!document.querySelector("#pvBody iframe"), fvCode: !!document.querySelector("#pvBody .fv-code") })')));
process.exit(0);
