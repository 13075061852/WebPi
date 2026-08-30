import { writeFileSync, copyFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proj = "C:/Users/13087/Desktop/大鱼吃小鱼";
copyFileSync(proj + "/draw_plane.py", proj + "/halo-hl-test.py");
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
await sleep(2500);
const clickRow = '(() => { const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname") && e.querySelector(".fname").textContent === "halo-hl-test.py"); if (!row) return "NOT IN TREE"; row.click(); return "ok"; })()';
console.log(await ev(clickRow));
await sleep(900);
const expr = '(() => {' +
  'const code = document.querySelector("#pvBody .fv-code");' +
  'const ln = document.querySelector("#pvBody .fvc-ln");' +
  'const body = document.querySelector("#pvBody .fvc-body");' +
  'if (!code) return { missing: true };' +
  'const spans = {};' +
  '["c-com","c-str","c-kw","c-num","c-fn"].forEach((cls) => { spans[cls] = body.querySelectorAll("." + cls).length; });' +
  'const lnCount = ln.textContent.split(String.fromCharCode(10)).length;' +
  'const lh = parseFloat(getComputedStyle(body).lineHeight);' +
  'const visualLines = Math.round(body.scrollHeight / lh);' +
  'return { lnRows: lnCount, visualLines: visualLines, spans: spans, text: body.textContent.slice(0, 50) };' +
'})()';
const info = await ev(expr);
console.log(JSON.stringify(info, null, 1));
const rr = await send("Page.captureScreenshot", { format: "png", clip: { x: 250, y: 40, width: 1010, height: 980, scale: 0.55 } });
writeFileSync("test/shot-hl.png", Buffer.from(rr.result.data, "base64"));
console.log("shot saved");
try { unlinkSync(proj + "/halo-hl-test.py"); } catch {}
console.log("test file removed");
process.exit(0);
