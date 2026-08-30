/** Sidebar file-list + preview-only center verification */
import { writeFileSync } from "node:fs";
const PORT = process.argv[2] || "9356";
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
  if (r.result?.exceptionDetails) { console.log("PAGE EXCEPTION:", JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return null; }
  return r.result?.result?.value;
});

await send("Runtime.enable");
await sleep(3000);

const r = await ev(`(async () => {
  const q = (s) => document.querySelector(s);
  const out = {};
  // 1) 侧栏文件区存在且已加载
  const sf = q(".side-files");
  out.sideFiles = !!sf && sf.querySelector("#wsTree") !== null;
  out.treeRows = sf ? sf.querySelectorAll(".trow").length : 0;
  out.inSidebar = sf ? sf.closest("#sidebar") !== null : false;
  out.aboveFooter = sf ? sf.nextElementSibling?.id === "modelCard" : false;
  // 2) 中间只有预览，无 tabs
  out.centerTabs = document.querySelectorAll(".center-tabs").length;
  out.cpanes = [...document.querySelectorAll(".cpane")].map((p) => p.id);
  out.previewActive = q("#cpane-preview")?.classList.contains("active");
  // 3) 点击侧栏中的 html 文件 → 中间 iframe 预览
  const htmlRow = [...sf.querySelectorAll(".trow.file")].find((r) => r.textContent.includes(".html"));
  if (htmlRow) {
    htmlRow.click();
    await new Promise((r) => setTimeout(r, 800));
    out.pvName = q("#pvName").textContent;
    out.hasIframe = !!q("#pvBody iframe");
    out.pvPath = q("#wsPath").textContent.slice(-20);
  }
  return JSON.stringify(out);
})()`);
console.log("layout:", r);

// 点击一个非预览文件（.py → 代码视图）
const r2 = await ev(`(async () => {
  const sf = document.querySelector(".side-files");
  const pyRow = [...sf.querySelectorAll(".trow.file")].find((r) => r.textContent.includes(".py"));
  if (!pyRow) return "no py file";
  pyRow.click();
  await new Promise((r) => setTimeout(r, 600));
  return JSON.stringify({ pvName: document.querySelector("#pvName").textContent, codeLines: document.querySelectorAll("#pvBody .fv-line").length });
})()`);
console.log("code view:", r2);

const rr = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/shot-sidebar-files.png", Buffer.from(rr.result.data, "base64"));
console.log("screenshot saved: test/shot-sidebar-files.png");
process.exit(0);
