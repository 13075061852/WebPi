import { writeFileSync, unlinkSync } from "node:fs";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then((r) => {
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 260));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(2500);

// 直接调用页面的 mdRender/rich 验证（模块作用域？app.js 是普通 script → 函数全局可见）
const MD = [
  "## 项目结构",
  "",
  "| 模块 | 说明 | 状态 |",
  "|:-----|------|-----:|",
  "| 渲染器 | Claude 风格 | ✅ |",
  "| 表格 | 完整支持 | ✅ |",
  "",
  "### 功能列表",
  "",
  "- [x] 标题渲染",
  "- [x] 表格渲染",
  "- [ ] 待办项",
  "  - 嵌套子项",
  "",
  "> 引用块：这里是一段引用文字",
  "",
  "**加粗** 与 *斜体* 与 ~~删除线~~ 与 `行内代码`",
  "",
  "```js",
  "const x = 1; // 代码块",
  "```",
  "",
  "1. 有序一项",
  "2. 有序二项",
].join("\n");
const expr = '(() => {' +
  'const div = document.createElement("div"); div.className = "md";' +
  'div.innerHTML = window.__mdRender(' + JSON.stringify(MD) + ');' +
  'document.body.appendChild(div);' +
  'return {' +
  ' h2: div.querySelectorAll("h2").length,' +
  ' h3: div.querySelectorAll("h3").length,' +
  ' table: div.querySelectorAll("table").length,' +
  ' th: div.querySelectorAll("th").length,' +
  ' tdAlignRight: !!div.querySelector("td[style*=right]"),' +
  ' ul: div.querySelectorAll("ul").length,' +
  ' ol: div.querySelectorAll("ol").length,' +
  ' checkbox: div.querySelectorAll("input[type=checkbox]").length,' +
  ' checked: div.querySelectorAll("input:checked").length,' +
  ' nested: div.querySelectorAll("li ul li").length,' +
  ' bq: div.querySelectorAll("blockquote").length,' +
  ' b: div.querySelectorAll("b").length,' +
  ' i: div.querySelectorAll("i").length,' +
  ' del: div.querySelectorAll("del").length,' +
  ' code: div.querySelectorAll("code").length,' +
  ' pre: div.querySelectorAll("pre").length,' +
  ' rawHash: div.innerHTML.includes("##"),' +
  ' rawPipe: div.innerHTML.includes("| 渲染器"),' +
  '};})()';
console.log(JSON.stringify(await ev(expr), null, 1));
process.exit(0);
