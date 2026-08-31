import { writeFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proj = "C:/Users/13087/Desktop/大鱼吃小鱼";
const txt = `${proj}/halo-view-test.txt`;
const js = `${proj}/halo-view-test.js`;
writeFileSync(txt, "这是一个纯文本文件。\n第二行内容，用于测试阅读视图的自动换行。\n".repeat(40));
writeFileSync(js, "// code file\nconst a = 1;\nfunction f(){ return a; }\n".repeat(30));
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

const open = async (name) => {
  const r = await ev(`(async () => {
    const row = [...document.querySelectorAll("#wsTree .trow.file")].find((e) => e.querySelector(".fname")?.textContent === "${name}");
    if (!row) return "NOT IN TREE";
    row.click();
    await new Promise((res) => setTimeout(res, 600));
    return "ok";
  })()`);
  return r;
};
const inspect = () => ev(`(() => {
  const fv = document.querySelector("#pvBody .file-view");
  const pb = document.querySelector("#pvBody").getBoundingClientRect();
  const fr = fv.getBoundingClientRect();
  return {
    fills: Math.abs(fr.width - pb.width) < 4 && Math.abs(fr.height - pb.height) < 4,
    w: Math.round(fr.width), h: Math.round(fr.height),
    fvRead: !!document.querySelector("#pvBody .fv-read"),
    fvLines: document.querySelectorAll("#pvBody .fv-line").length,
    readWrap: document.querySelector("#pvBody .fv-read") ? getComputedStyle(document.querySelector("#pvBody .fv-read")).whiteSpace : null,
  };
})()`);

console.log("txt:", await open("halo-view-test.txt"), JSON.stringify(await inspect()));
console.log("js:", await open("halo-view-test.js"), JSON.stringify(await inspect()));

try { unlinkSync(txt); unlinkSync(js); } catch {}
console.log("test files removed");
process.exit(0);
