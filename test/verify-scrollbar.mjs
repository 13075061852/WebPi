/** Verify iframe scrollbar hidden in tablet/mobile preview, visible on desktop */
import { writeFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造一个长页面
const proj = "C:/Users/13087/Desktop/大鱼吃小鱼";
const tall = `${proj}/halo-scroll-test.html`;
writeFileSync(tall, `<html><body style="margin:0;font-family:sans-serif"><div style="height:3000px;background:linear-gradient(#fff,#cce)">3000px tall — scroll me</div></body></html>`);

let main;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    main = list.find((t) => t.type === "page" && t.url.endsWith("index.html"));
    if (main) break;
  } catch {}
  await sleep(500);
}
if (!main) { console.log("NO WINDOW"); process.exit(1); }

const ws = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => {
  if (r.result?.exceptionDetails) { console.log("PAGE EXCEPTION:", JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return null; }
  return r.result?.result?.value;
});

await send("Runtime.enable");
await sleep(2500);

// 点击文件树加载长页面
const r0 = await ev(`(async () => {
  const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname")?.textContent === "halo-scroll-test.html");
  if (!row) return "FILE NOT IN TREE";
  row.click();
  await new Promise((r) => setTimeout(r, 700));
  return "loaded: " + document.getElementById("pvName").textContent;
})()`);
console.log(r0);

const clip = { x: 320, y: 120, width: 920, height: 900, scale: 0.55 };
const out = {};
for (const dev of ["desktop", "tablet", "mobile"]) {
  await ev(`(async () => {
    document.querySelector('.pvdev[data-dev="${dev}"]').click();
    await new Promise((r) => setTimeout(r, 500));
  })()`);
  const rr = await send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(`test/shot-scrollbar-${dev}.png`, Buffer.from(rr.result.data, "base64"));
  out[dev] = `test/shot-scrollbar-${dev}.png`;
}
console.log("shots:", JSON.stringify(out));

try { unlinkSync(tall); } catch {}
console.log("test file removed");
process.exit(0);
