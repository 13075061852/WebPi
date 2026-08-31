/** Verify rubber-band overscroll + bounce-back at document edges */
import { writeFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proj = "C:/Users/13087/Desktop/大鱼吃小鱼";
const tall = `${proj}/halo-os-test.html`;
writeFileSync(tall, `<html><body style="margin:0;background:#f5f5f5;font-family:sans-serif">
<div style="height:3500px;background:linear-gradient(#fff,#ccf)"><p style="font-size:28px;margin:10px">TOP</p></div>
</body></html>`);

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
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.result?.value);

await send("Runtime.enable");
await sleep(2500);

console.log(await ev(`(async () => {
  const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname")?.textContent === "halo-os-test.html");
  if (!row) return "FILE NOT IN TREE";
  row.click();
  await new Promise((r) => setTimeout(r, 800));
  document.querySelector('.pvdev[data-dev="mobile"]').click();
  await new Promise((r) => setTimeout(r, 900));
  return "ready";
})()`));

const ifr = await ev(`(() => { const r = document.querySelector("#pvBody iframe").getBoundingClientRect(); const p = document.querySelector("#pvBody").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), px: Math.round(p.x), py: Math.round(p.y), pw: Math.round(p.width), ph: Math.round(p.height), ov: getComputedStyle(document.querySelector("#pvBody")).overflow }; })()`);
console.log("iframe/pvBody rect:", JSON.stringify(ifr));
const px = Math.round(ifr.x + ifr.w / 2), py = Math.round(ifr.y + ifr.h / 2);
const drag = async (n, step, speed) => {
  const y0 = py - 300;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: y0, button: "left", clickCount: 1 });
  for (let i = 1; i <= n; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: y0 + i * step, button: "left" }); await sleep(speed); }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: y0 + n * step, button: "left", clickCount: 1 });
};

// 阶段1：大甩（往下拖回顶部）→ 惯性撞顶
await ev(`window.__pmLog = []; window.__haloOs = null`);
await drag(8, 26, 4);
await sleep(2000); // 等惯性撞顶并结束

// 阶段2：scrollTop=0 时继续往下拖 → 橡皮筋
await ev(`window.__haloOs = null`);
// 拖 5 步后（release 前）读一次峰值
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py - 300, button: "left", clickCount: 1 });
for (let i = 1; i <= 5; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py - 300 + i * 20, button: "left" }); await sleep(6); }
await sleep(120);
const osPeak = await ev(`window.__haloOs`);
for (let i = 6; i <= 10; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py - 300 + i * 20, button: "left" }); await sleep(6); }
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py - 300 + 10 * 20, button: "left", clickCount: 1 });
const timeline = [];
for (let i = 0; i < 14; i++) {
  await sleep(100);
  timeline.push(await ev(`window.__haloOs?.v`));
}
console.log("os peak during drag:", JSON.stringify(osPeak));
console.log("os timeline (v):", JSON.stringify(timeline));
console.log("rubberBand:", osPeak?.v != null && osPeak.v < -10 ? "OK" : "FAIL", "| bounceBack:", timeline[timeline.length - 1] === 0 ? "OK" : "FAIL");

try { unlinkSync(tall); } catch {}
console.log("test file removed");
process.exit(0);
