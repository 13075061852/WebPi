/* 三种设备模式的空状态测量 + 截图 */
const fs = await import("node:fs");
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
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(3000);

for (const dev of ["desktop", "tablet", "mobile"]) {
  await ev(`document.querySelector(".pvdev[data-dev=\\"${dev}\\"]").click(); true`);
  await sleep(400);
  const m = await ev(`(() => {
    const body = document.getElementById("pvBody");
    const gs = document.querySelector("#pvBody .pv-gscreen");
    const ic = document.querySelector("#pvBody .pv-empty-ico");
    const ps = [...document.querySelectorAll("#pvBody .pv-gscreen p")];
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const bodyR = r(body), gsR = r(gs);
    // 内容总高度（icon + gaps + 文本）vs gscreen 内高
    const contentH = ic.offsetHeight + 14 + ps[0].offsetHeight + 14 + ps[1].offsetHeight;
    // 图标中心 vs 屏幕中心 的偏移（不含 padding 影响的视觉中心检查）
    const icC = { x: r(ic).x + r(ic).w / 2 - gsR.x, y: r(ic).y + r(ic).h / 2 - gsR.y };
    return JSON.stringify({
      devMode: "${dev}",
      body: bodyR, gscreen: gsR,
      icon: r(ic), fontSize: getComputedStyle(ic).fontSize,
      p1: r(ps[0]), p2: r(ps[1]),
      contentH, gscreenInnerH: gs.offsetHeight - 48,
      overflow: contentH > gs.offsetHeight - 48,
      iconCenterInGs: icC,
      gsCenter: { x: gsR.w / 2, y: gsR.h / 2 }
    });
  })()`);
  console.log(m);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot.result) fs.writeFileSync(`D:/GitHub/WebPi/test/pv-empty-${dev}.png`, Buffer.from(shot.result.data, "base64"));
}
console.log("shots saved");
process.exit(0);
