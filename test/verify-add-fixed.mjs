/* 修复后端到端验证（干净环境版）：真实点击“＋ 添加” → 原生目录对话框 → 键入路径 → 轮询断言左侧刷新 */
const PORT = "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { execSync } = await import("node:child_process");
const PS = "C:/Users/13087/AppData/Local/Temp/ps";
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
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 260));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(3000);

const snap = () => ev(`JSON.stringify({
  chip: document.getElementById("projectName").textContent.trim(),
  wsPath: document.getElementById("wsPath").textContent,
  projRows: [...document.querySelectorAll("#projList .proj-row .pj-name")].map(x => x.textContent.trim()),
  projActive: (document.querySelector("#projList .proj-row.active .pj-name")||{}).textContent || "",
  treeRows: document.querySelectorAll("#wsTree .trow").length,
  treeTop: [...document.querySelectorAll("#wsTree .trow .fname")].slice(0,6).map(x => x.textContent),
  toasts: [...document.querySelectorAll("#toasts .toast")].map(t => t.textContent.trim()).slice(-3)
})`);

const dialogOpen = () => {
  try {
    const out = execSync(`powershell -ExecutionPolicy Bypass -File ${PS}/listwins2.ps1`, { timeout: 10000 }).toString();
    return out.includes("选择项目目录");
  } catch { return false; }
};

console.log("== 添加前 ==");
console.log(await snap());

// 聚焦主窗口 → 点击“＋ 添加” → 对话框应弹出
execSync(`powershell -ExecutionPolicy Bypass -File ${PS}/focus.ps1`, { timeout: 10000 });
await sleep(800);
await ev(`document.getElementById("projAdd").click(); "clicked"`);
await sleep(2000);
console.log("对话框已弹出:", dialogOpen());

// 键入 WebPi 路径
execSync(`powershell -ExecutionPolicy Bypass -File ${PS}/pick-webpi.ps1`, { timeout: 20000 });
console.log("已键入路径，等待切换完成…");

// 轮询等待：chip 变成 WebPi（agent 核心重建可能较慢）
let final = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const s = JSON.parse(await snap());
  if (s.chip === "WebPi" && s.wsPath.includes("WebPi")) { final = s; break; }
  final = s;
}
console.log("== 添加后 ==");
console.log(JSON.stringify(final));

// 取消场景：再点添加 → Esc → 列表应保持不变
await ev(`document.getElementById("projAdd").click(); "clicked"`);
await sleep(1500);
execSync(`powershell -ExecutionPolicy Bypass -File ${PS}/esc.ps1`, { timeout: 8000 });
await sleep(1200);
console.log("== 取消后（应与添加后一致）==");
console.log(await snap());

process.exit(0);
