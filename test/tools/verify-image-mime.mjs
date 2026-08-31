/** Verify empty-MIME clipboard image gets sniffed to image/png */
import { writeFileSync } from "node:fs";
const PORT = process.argv[2] || "9363";
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

const r = await ev(`(async () => {
  // 1x1 PNG 的字节
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], "shot.png", { type: "" })); // 模拟 Windows 剪贴板空 MIME
  const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  document.getElementById("input").dispatchEvent(evt);
  await new Promise((r) => setTimeout(r, 400));
  const chips = document.querySelectorAll("#attachRow .attach-chip img");
  return JSON.stringify({
    chips: chips.length,
    chipSrcPrefix: chips.length ? chips[0].src.slice(0, 22) : null,
  });
})()`);
console.log("empty-MIME paste:", r);

// 复制该验证截图
const rr = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/shot-image-mime.png", Buffer.from(rr.result.data, "base64"));
process.exit(0);
