/** Empty-state ghost device frames per mode + real shell when content loads */
import { writeFileSync } from "node:fs";
const PORT = process.argv[2] || "9370";
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

// 三种模式空状态截图
const shots = [["desktop", "test/shot-empty-desktop.png"], ["tablet", "test/shot-empty-tablet.png"], ["mobile", "test/shot-empty-mobile.png"]];
for (const [dev, file] of shots) {
  const r = await ev(`(async () => {
    document.querySelector('.pvdev[data-dev="${dev}"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const body = document.getElementById("pvBody");
    const gs = body.querySelector(".pv-gscreen");
    const st = getComputedStyle(document.getElementById("pvBody"), "::before");
    return JSON.stringify({ ghost: !!gs, decoVisible: st.content !== "none" && st.width !== "auto" && st.width !== "0px" });
  })()`);
  console.log(dev, "empty:", r);
  const rr = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(rr.result.data, "base64"));
}

// 加载 iframe 内容后外壳应恢复（island / stand 出现）
const r2 = await ev(`(async () => {
  document.querySelector('.pvdev[data-dev="mobile"]').click();
  const body = document.getElementById("pvBody");
  body.innerHTML = '<iframe src="about:blank"></iframe>';
  await new Promise((r) => setTimeout(r, 200));
  const st = getComputedStyle(body, "::after");
  return JSON.stringify({ islandBack: st.content !== "none", width: st.width });
})()`);
console.log("mobile with iframe:", r2);
process.exit(0);
