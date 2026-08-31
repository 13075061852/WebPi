/** 验证设备外壳结构：壳层尺寸/圆角/渐变/伪元素细节/反光覆盖 + 触摸脚本仍正常 */
import { writeFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proj = "C:/Users/13087/Desktop/大鱼吃小鱼";
const tall = `${proj}/halo-shell-test.html`;
writeFileSync(tall, `<html><body style="margin:0;font-family:sans-serif"><div style="height:1600px;background:linear-gradient(#fff,#cde)"><p style="font-size:24px;margin:10px">SHELL TEST</p></div></body></html>`);

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
  const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname")?.textContent === "halo-shell-test.html");
  if (!row) return "FILE NOT IN TREE";
  row.click();
  await new Promise((r) => setTimeout(r, 800));
  return "ready";
})()`));

for (const dev of ["desktop", "tablet", "mobile"]) {
  await ev(`document.querySelector('.pvdev[data-dev="${dev}"]').click()`);
  await sleep(500);
  const info = await ev(`(() => {
    const shell = document.querySelector("#pvBody .dev-shell");
    const ifr = document.querySelector("#pvBody .dev-shell iframe");
    if (!shell || !ifr) return { missing: true };
    const cs = getComputedStyle(shell);
    const is = getComputedStyle(ifr);
    const before = getComputedStyle(shell, "::before");
    const after = getComputedStyle(shell, "::after");
    const sr = shell.getBoundingClientRect();
    const ir = ifr.getBoundingClientRect();
    return {
      shell: { w: Math.round(sr.width), h: Math.round(sr.height), radius: cs.borderRadius, pad: cs.padding, bg: cs.backgroundImage.slice(0, 60), shadows: cs.boxShadow.split("),").length },
      iframe: { w: Math.round(ir.width), h: Math.round(ir.height), inset: is.boxShadow.includes("inset") },
      before: { content: before.content !== "none", z: before.zIndex, coversScreen: before.position === "absolute" },
      after: { content: after.content !== "none", bg: after.backgroundImage.slice(0, 50), w: after.width, h: after.height },
    };
  })()`);
  console.log(dev, "→", JSON.stringify(info));
}

// 触摸脚本仍正常（手机模式拖一下）
await ev(`document.querySelector('.pvdev[data-dev="mobile"]').click()`);
await sleep(400);
const ifr = await ev(`(() => { const r = document.querySelector("#pvBody iframe").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const px = Math.round(ifr.x + ifr.w / 2), py = Math.round(ifr.y + ifr.h / 2);
await ev(`window.__haloTouchState = null`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", clickCount: 1 });
for (let i = 1; i <= 8; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py - i * 26, button: "left" }); await sleep(4); }
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py - 8 * 26, button: "left", clickCount: 1 });
await sleep(120);
const s1 = await ev(`window.__haloTouchState`);
console.log("touch drag scrollY:", s1?.y > 100 ? `OK (${s1.y})` : `FAIL (${s1?.y})`);

try { unlinkSync(tall); } catch {}
console.log("test file removed");
process.exit(0);
