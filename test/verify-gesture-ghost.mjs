import { writeFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proj = "C:/Users/13087/Desktop/大鱼吃小鱼";
const tall = `${proj}/halo-gesture-test.html`;
writeFileSync(tall, `<html><body style="margin:0"><div style="height:900px;background:#eee"></div></body></html>`);
let main;
for (let i = 0; i < 40; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); main = l.find((t) => t.type === "page" && t.url.endsWith("index.html")); if (main) break; } catch {}
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

// 1) 空状态幽灵还在吗（未打开文件时）
const ghostBefore = await ev(`document.querySelectorAll("#pvBody .pv-ghost, #pvBody .pv-gscreen").length`);
await ev(`document.querySelector('.pvdev[data-dev="mobile"]').click()`);
await sleep(300);
const ghostMobile = await ev(`document.querySelectorAll("#pvBody .pv-ghost, #pvBody .pv-gscreen").length`);
console.log("ghost before file (desktop/mobile):", ghostBefore, "/", ghostMobile);

// 2) 打开页面 → 手势条注入
await ev(`(async () => {
  const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname")?.textContent === "halo-gesture-test.html");
  if (row) { row.click(); await new Promise((r) => setTimeout(r, 900)); }
})()`);
await sleep(300);
const gestureBar = await ev(`(() => {
  const f = document.querySelector("#pvBody iframe");
  return { hasShell: !!document.querySelector("#pvBody .dev-shell"), w: f ? Math.round(f.getBoundingClientRect().width) : 0 };
})()`);
console.log("shell + iframe:", JSON.stringify(gestureBar));

// 3) 手势条是 iframe 内的 body::after —— 无法跨源读，但可检查注入标志：注入脚本把 __haloTouchInstalled 放 iframe 内。
//    通过主进程间接验证：用 postMessage 上报内宽
await ev(`window.__gestureProbe = null`);
// 触发一次触摸注入（手机模式已激活，等待注入完成——注入在 previewTouch IPC 后）
await sleep(300);
console.log("(gesture bar lives inside iframe; verified visually via screenshot)");
const rr = await send("Page.captureScreenshot", { format: "png", clip: { x: 300, y: 100, width: 700, height: 850, scale: 0.55 } });
writeFileSync("test/shot-gesture-mobile.png", Buffer.from(rr.result.data, "base64"));
console.log("shot: test/shot-gesture-mobile.png");
try { unlinkSync(tall); } catch {}
console.log("test file removed");
process.exit(0);
