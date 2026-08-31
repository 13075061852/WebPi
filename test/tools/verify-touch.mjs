/** Verify touch simulation: drag-scroll + inertia via postMessage reports; tap via screenshot */
import { writeFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proj = "C:/Users/13087/Desktop/大鱼吃小鱼";
const tall = `${proj}/halo-touch-test.html`;
writeFileSync(tall, `<html><body style="margin:0;font-family:sans-serif">
<div style="height:3000px;background:linear-gradient(#fff,#ccf)">
<p style="font-size:28px;margin:10px">TOP MARKER</p>
<button id="tapBtn" style="font-size:24px;margin:10px;padding:12px" onclick="this.textContent='CLICKED-OK'">TAP ME</button>
<p style="margin-top:2400px;font-size:28px">BOTTOM MARKER</p>
</div></body></html>`);

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
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => {
  if (r.result?.exceptionDetails) { console.log("PAGE EXCEPTION:", JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return null; }
  return r.result?.result?.value;
});

await send("Runtime.enable");
await sleep(2500);

console.log(await ev(`(async () => {
  const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname")?.textContent === "halo-touch-test.html");
  if (!row) return "FILE NOT IN TREE";
  row.click();
  await new Promise((r) => setTimeout(r, 800));
  document.querySelector('.pvdev[data-dev="tablet"]').click();
  await new Promise((r) => setTimeout(r, 900));
  return "ready";
})()`));

const iframeEl = await ev(`(() => { const r = document.querySelector("#pvBody iframe").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
if (!iframeEl) { console.log("NO IFRAME"); process.exit(1); }
const px = Math.round(iframeEl.x + iframeEl.w / 2), py = Math.round(iframeEl.y + iframeEl.h / 2);

// 1) 普通点击（无位移）仍触发 click（先测，页面还在顶部）
const btnPos = { x: Math.round(iframeEl.x + 30), y: Math.round(iframeEl.y + 85) };
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: btnPos.x, y: btnPos.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btnPos.x, y: btnPos.y, button: "left", clickCount: 1 });
await sleep(250);
console.log("down report:", JSON.stringify(await ev(`window.__haloDown`)), "click report:", JSON.stringify(await ev(`window.__haloClick`)));
const rr = await send("Page.captureScreenshot", { format: "png", clip: { x: 320, y: 60, width: 940, height: 960, scale: 0.55 } });
writeFileSync("test/shot-touch-tap.png", Buffer.from(rr.result.data, "base64"));
console.log("screenshot: test/shot-touch-tap.png（按钮应显示 CLICKED-OK）");

// 2) 按住拖动（向上滑 → 内容下滚）+ 惯性
await ev(`window.__haloTouchState = null`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", clickCount: 1 });
for (let i = 1; i <= 8; i++) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py - i * 28, button: "left" });
  await sleep(4);
}
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py - 8 * 28, button: "left", clickCount: 1 });
await sleep(150);
const rep1 = await ev(`window.__haloTouchState`);
// 追踪滑行过程：每 120ms 采样，直到 ph:2（滑行结束）或 4s 超时
let maxY = rep1?.y || 0, settled = null;
for (let i = 0; i < 34; i++) {
  await sleep(120);
  const s = await ev(`window.__haloTouchState`);
  if (s?.y > maxY) maxY = s.y;
  if (s?.ph === 2) { settled = s.y; break; }
}
console.log("release scrollY:", rep1?.y, "max during glide:", Math.round(maxY), "settled:", settled);
console.log("dragScroll:", (rep1?.y || 0) > 50 ? "OK" : "FAIL", "| inertia:", (maxY || 0) > (rep1?.y || 0) + 50 ? "OK" : "FAIL", "| glideEnd:", settled != null ? "OK" : "(timeout)");

try { unlinkSync(tall); } catch {}
console.log("test file removed");
process.exit(0);
