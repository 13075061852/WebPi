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
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => {
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 240));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(3000);
// 切浅色主题（模拟用户环境）
await ev('document.documentElement.dataset.theme = "light"; try { localStorage.setItem("halo-theme", "light"); } catch {}');
await sleep(400);
await ev('(() => { const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname") && /[.]html$/.test(e.querySelector(".fname").textContent)); if (row) row.click(); })()');
await sleep(1500);
await ev('(document.querySelector(".pvdev[data-dev=mobile]") || document.querySelector("#pvBody [data-dev=mobile]")).click()');
await sleep(800);
const check = await ev('JSON.stringify({ bodyBg: getComputedStyle(document.getElementById("pvBody")).backgroundColor, shellBg: getComputedStyle(document.querySelector("#pvBody .dev-shell")).backgroundColor, shellBorder: getComputedStyle(document.querySelector("#pvBody .dev-shell")).borderColor, iframeBg: getComputedStyle(document.querySelector("#pvBody iframe")).backgroundColor, bg1Var: getComputedStyle(document.documentElement).getPropertyValue("--bg1") })');
console.log("light theme:", check);
const rr = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("test/shot-transparent-mobile.png", Buffer.from(rr.result.data, "base64"));
console.log("shot saved");
process.exit(0);
