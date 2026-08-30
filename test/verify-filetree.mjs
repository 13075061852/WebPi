/** Sidebar file tree: create file/dir, nested create, delete — end-to-end */
import { writeFileSync } from "node:fs";
const PORT = process.argv[2] || "9365";
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

const treeHas = (name) => ev(`[...document.querySelectorAll("#wsTree .trow .fname")].some((e) => e.textContent === ${JSON.stringify(name)})`);

// 1) 新建文件（根目录）
await ev(`document.getElementById("btnNewFile").click()`);
await sleep(150);
let r = await ev(`(async () => {
  const inp = document.querySelector("#wsTree .create-input");
  if (!inp) return "NO INPUT";
  inp.value = "halo-test-tmp.txt";
  inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 800));
  return "committed";
})()`);
console.log("create file:", r, "| in tree:", await treeHas("halo-test-tmp.txt"));

// 2) 新建文件夹
await ev(`document.getElementById("btnNewDir").click()`);
await sleep(150);
r = await ev(`(async () => {
  const inp = document.querySelector("#wsTree .create-input");
  if (!inp) return "NO INPUT";
  inp.value = "halo-test-dir";
  inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 800));
  return "committed";
})()`);
console.log("create dir:", r, "| in tree:", await treeHas("halo-test-dir"));

// 3) 选中文件夹 → 在其内部新建文件（行内输入应出现在展开的子级里）
r = await ev(`(async () => {
  const row = [...document.querySelectorAll("#wsTree .trow.dir")].find((e) => e.querySelector(".fname")?.textContent === "halo-test-dir");
  if (!row) return "NO DIR ROW";
  row.click();
  await new Promise((r2) => setTimeout(r2, 300));
  document.getElementById("btnNewFile").click();
  await new Promise((r2) => setTimeout(r2, 150));
  const inp = document.querySelector("#wsTree .trow-create .create-input");
  if (!inp) return "NO NESTED INPUT";
  inp.value = "inner.txt";
  inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r2) => setTimeout(r2, 800));
  const names = [...document.querySelectorAll("#wsTree .trow .fname")].map((e) => e.textContent);
  return JSON.stringify({ hasInner: names.includes("inner.txt"), dirSelected: row.className.includes("selected") });
})()`);
console.log("nested create:", r);

// 截图（新样式 + 展开的文件夹）
let rr = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/shot-filetree-create.png", Buffer.from(rr.result.data, "base64"));

// 4) 删除：两步确认（直接 .click() 触发，绕过 hover 可见性）
r = await ev(`(async () => {
  const results = {};
  const delByName = async (name) => {
    const row = [...document.querySelectorAll("#wsTree .trow")].find((e) => e.querySelector(".fname")?.textContent === name);
    if (!row) return "NO ROW";
    const del = row.querySelector(".trow-del");
    del.click(); // 第一步：进入确认态
    await new Promise((r2) => setTimeout(r2, 120));
    if (!del.classList.contains("confirm")) return "NO CONFIRM STATE";
    del.click(); // 第二步：确认删除
    await new Promise((r2) => setTimeout(r2, 900));
    return "deleted";
  };
  results.inner = await delByName("inner.txt");
  results.dir = await delByName("halo-test-dir");
  results.file = await delByName("halo-test-tmp.txt");
  const names = [...document.querySelectorAll("#wsTree .trow .fname")].map((e) => e.textContent);
  results.clean = !names.some((n) => n.includes("halo-test"));
  return JSON.stringify(results);
})()`);
console.log("delete:", r);

rr = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/shot-filetree-final.png", Buffer.from(rr.result.data, "base64"));
console.log("screenshots saved");
process.exit(0);
