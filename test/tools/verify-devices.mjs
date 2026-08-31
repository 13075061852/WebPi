/** Device-switcher verification: preview pane + tablet/mobile iframe widths */
import { writeFileSync } from "node:fs";
const PORT = process.argv[2] || "9354";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 切到预览页签并注入 iframe（模拟已加载预览）
await ev(`(async () => {
  document.querySelector('[data-cpane="preview"]').click();
  await new Promise((r) => setTimeout(r, 200));
  const body = document.getElementById("pvBody");
  body.innerHTML = '<iframe src="about:blank"></iframe>';
})()`);

const shots = [
  ["desktop", "test/shot-dev-desktop.png"],
  ["tablet", "test/shot-dev-tablet.png"],
  ["mobile", "test/shot-devices.png"]
];
for (const [dev, file] of shots) {
  const r = await ev(`(async () => {
    document.querySelector('.pvdev[data-dev="${dev}"]').click();
    await new Promise((r) => setTimeout(r, 150));
    const body = document.getElementById("pvBody");
    const f = body.querySelector("iframe");
    return JSON.stringify({ cls: body.className.split(" ").filter((c) => c.startsWith("dev-")).join(","), w: Math.round(f.getBoundingClientRect().width), label: document.getElementById("pvDevSize").textContent });
  })()`);
  console.log(dev, "→", r);
  const rr = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(rr.result.data, "base64"));
}
console.log("3 screenshots saved");
process.exit(0);
