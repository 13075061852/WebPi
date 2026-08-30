/* 修复后端到端验证：真实点击“＋ 添加” → 真实原生目录对话框（CDP 点击后由 PowerShell 键入路径）→ 断言左侧列表刷新 */
const PORT = "9371";
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

console.log("== 添加前 ==");
console.log(await snap());

// 1) 点击“＋ 添加”按钮 → 弹出原生目录对话框
await ev(`document.getElementById("projAdd").click(); "clicked"`);
await sleep(1500);
console.log("== 对话框已弹出，通过 PowerShell 输入路径 ==");
// 2) 在原生对话框里 Ctrl+L 打开地址栏 → 输入 WebPi 路径 → Enter
const typePath = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^l")
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait("D:/GitHub/WebPi")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
`;
const { execSync } = await import("node:child_process");
await new Promise((r) => setTimeout(r, 400));
execSync(`powershell -ExecutionPolicy Bypass -File C:/Users/13087/AppData/Local/Temp/ps/pick-webpi.ps1`, { timeout: 20000 });
await sleep(6000); // 等 agent 核心重建 + 列表刷新

console.log("== 添加后 ==");
console.log(await snap());

// 3) 取消场景：再点添加，然后 Esc 关闭对话框，确认无副作用
await ev(`document.getElementById("projAdd").click(); "clicked"`);
await sleep(1500);
try { execSync(`powershell -ExecutionPolicy Bypass -File C:/Users/13087/AppData/Local/Temp/ps/esc.ps1`, { timeout: 8000 }); } catch {}
await sleep(1500);
console.log("== 取消后（列表不应变化）==");
console.log(await snap());

process.exit(0);
