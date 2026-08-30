import { writeFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proj = "C:/Users/13087/Desktop/大鱼吃小鱼";
const tall = `${proj}/halo-round-test.html`;
writeFileSync(tall, `<html><body style="margin:0"><div style="height:900px;background:#e8ecf2"></div></body></html>`);
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
console.log(await ev(`(async () => {
  const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname")?.textContent === "halo-round-test.html");
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
    const cs = getComputedStyle(shell), is = getComputedStyle(ifr);
    const sr = shell.getBoundingClientRect(), ir = ifr.getBoundingClientRect();
    const pb = document.querySelector("#pvBody").getBoundingClientRect();
    return {
      shellRadius: cs.borderRadius, iframeRadius: is.borderRadius,
      iframeBg: is.backgroundColor,
      gap: { left: Math.round(ir.left - sr.left), right: Math.round(sr.right - ir.right), top: Math.round(ir.top - sr.top) },
      shellW: Math.round(sr.width), pvW: Math.round(pb.width),
      reflectAlpha: getComputedStyle(shell, "::before").backgroundImage.slice(0, 90),
    };
  })()`);
  console.log(dev, "→", JSON.stringify(info));
}
try { unlinkSync(tall); } catch {}
console.log("test file removed");
process.exit(0);
