import fs from "node:fs";
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
await send("Runtime.enable");
await sleep(3200);
await send("Runtime.evaluate", { expression: '(() => { const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname") && /[.]html$/.test(e.querySelector(".fname").textContent)); if (row) row.click(); })()' });
await sleep(1500);
await send("Runtime.evaluate", { expression: '(document.querySelector(".pvdev[data-dev=tablet]") || {}).click && document.querySelector(".pvdev[data-dev=tablet]").click()' });
await sleep(900);
const rr = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("test/shot-dark-stage.png", Buffer.from(rr.result.data, "base64"));
console.log("shot saved: test/shot-dark-stage.png");
process.exit(0);
