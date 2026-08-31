/* 复现“添加项目后左侧列表不刷新”的 bug：
 * 1) 读取当前状态
 * 2) 模拟主进程 pick-project 处理器在对话框返回后立即完成的切换（useProject 与它等价：设置 cwd + 重启 runtime + pushState）
 * 3) 用渲染进程 pickProject() 里的守卫表达式做判断，观察是否提前 return
 * 4) 检查 DOM：顶部目录名 / 左侧项目列表 / 文件树
 */
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
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(3000);

console.log("== 1) 添加前状态 ==");
console.log(await ev(`(async () => {
  const st = await window.halo.getState();
  return JSON.stringify({
    cwd: st.data.cwd,
    chip: document.getElementById("projectName").textContent.trim(),
    projRows: [...document.querySelectorAll("#projList .proj-row .pj-name")].map(x => x.textContent.trim()),
    treeRows: document.querySelectorAll("#wsTree .trow").length,
    treeFirst: (document.querySelector("#wsTree .fname")||{}).textContent || "",
    haloPickWritable: (() => { try { const before = window.halo.pickProject; window.halo.pickProject = null; const after = window.halo.pickProject; return before !== after; } catch(e){ return "threw:" + e.message; } })()
  });
})()`));

console.log("== 2) 模拟对话框选定新目录（主进程立即切项目 + pushState，渲染进程 S.state 随之更新）==");
console.log(await ev(`(async () => {
  const r = await window.halo.useProject("D:/GitHub/WebPi"); // 与 pick-project 处理器内部等价
  await new Promise(res => setTimeout(res, 300)); // 等状态事件落地
  return JSON.stringify({ ok: r.ok, stateCwd: (await window.halo.getState()).data.cwd });
})()`));

console.log("== 3) 渲染进程 pickProject() 的守卫判断 ==");
console.log(await ev(`(async () => {
  const dir = "D:\\\\GitHub\\\\WebPi"; // 对话框返回的原生路径（反斜杠）
  const norm = (p) => String(p || "").replace(/\\\\/g, "/").replace(/\\/+$/, "").toLowerCase();
  const st = (await window.halo.getState()).data;
  const guard = norm(dir) === norm(st.cwd || "");   // 与 pickProject 里的守卫同值（S.state 即由此状态更新）
  return JSON.stringify({ dir, stateCwd: st.cwd, normDir: norm(dir), normState: norm(st.cwd), guardHit: guard });
})()`));

console.log("== 4) 守卫命中后 DOM 状态（模拟 pickProject 提前 return）==");
console.log(await ev(`JSON.stringify({
  chip: document.getElementById("projectName").textContent.trim(),
  projRows: [...document.querySelectorAll("#projList .proj-row .pj-name")].map(x => x.textContent.trim()),
  treeRows: document.querySelectorAll("#wsTree .trow").length,
  treeFirst: (document.querySelector("#wsTree .fname")||{}).textContent || "",
  wsPath: document.getElementById("wsPath").textContent
})`));

// 清理：切回原项目
console.log("== 5) 清理 ==");
console.log(await ev(`(async () => {
  const list = (await window.halo.projectsList()).data || [];
  const first = list[0] && list[0].cwd;
  if (first) { await window.halo.projectSwitch(first); }
  return "switched back to: " + first;
})()`));
process.exit(0);
