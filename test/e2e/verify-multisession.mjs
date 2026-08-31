/* 多会话并发端到端验证（真实模型链路，隔离会话目录）：
 * 1. 会话 A 开始任务 → 不等完成切到新会话 B 发任务
 * 2. 验证 A 的任务在后台继续执行并完整完成（旧架构切换会 abort）
 * 3. 验证 A/B 各自独立响应、独立会话文件、可来回切换
 * 4. 验证 A 执行期间 listSessions 标记 running
 */
import fs from "node:fs";
import path from "node:path";
import { HaloStore, PiBridge } from "../../src/main/pi-bridge.mjs";

// 用 Electron 内置 Node 运行（WebSocket 代理行为与真实环境一致）：
// 纯 node 的 WebSocket 不走 HTTP 代理，模型流式调用会 fetch failed。
if (!process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = await import("node:child_process");
  const electron = process.platform === "win32"
    ? path.join(import.meta.dirname, "..", "..", "node_modules", "electron", "dist", "electron.exe")
    : path.join(import.meta.dirname, "..", "..", "node_modules", ".bin", "electron");
  process.env.ELECTRON_RUN_AS_NODE = "1";
  const child = spawn(electron, [process.argv[1]], { stdio: "inherit", env: process.env });
  child.on("exit", (c) => process.exit(c ?? 0));
  child.on("error", (e) => { console.error(e); process.exit(1); });
  await new Promise(() => {}); // 保持父进程存活直到子进程退出
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = "D:/GitHub/WebPi/.halo-ms-test";
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const store = new HaloStore(path.join(tmp, "halo-settings.json"));
store.set("cwd", "D:/GitHub/WebPi");

const b = new PiBridge(store, {}, { sessionDir: path.join(tmp, "sessions") });
b.onEvent(() => {});
await b.start("D:/GitHub/WebPi");
const stA0 = b.publicState();
console.log("started, focus session:", stA0.sessionId);

// ---- 会话 A：开始任务（较长任务保证执行窗口），不等待完成 ----
const pA = b.prompt("请查看当前目录的 package.json，把 devDependencies 里的包名逐个列出来").catch((e) => ({ error: String(e?.message || e) }));
// 轮询等待 A 落盘且 running 标记可见（最长 20s）
let sawRunning = false;
for (let i = 0; i < 20 && !sawRunning; i++) {
  const ls = await b.listSessions();
  sawRunning = ls.some((s) => s.running);
  if (!sawRunning) await sleep(1000);
}
console.log("A running flag visible while executing:", sawRunning);
if (!sawRunning) throw new Error("执行中的会话未显示 running 标记");

// ---- 不等 A 完成，切到新会话 B 发第二个任务 ----
const stB = await b.newSession();
console.log("switched to B:", stB.sessionId, "| different from A:", stB.sessionId !== stA0.sessionId);
if (stB.sessionId === stA0.sessionId) throw new Error("新会话未生效");
const pB = b.prompt("请用一句话回答：2+2 等于几？").catch((e) => ({ error: String(e?.message || e) }));
// ---- 两个任务并行完成 ----
const [rA, rB] = await Promise.all([pA, pB]);
if (rA?.error) throw new Error("会话 A 任务失败：" + rA.error);
if (rB?.error) throw new Error("会话 B 任务失败：" + rB.error);
console.log("both tasks completed (parallel, no abort)");

// A 落盘后从列表定位（后台完成时焦点可能已切走，prompt 返回值反映的是焦点状态）
let aFileAfter = null;
for (let i = 0; i < 40 && !aFileAfter; i++) {
  const ls = await b.listSessions();
  aFileAfter = ls.find((s) => (s.name || "").includes("package.json"))?.file || null;
  if (!aFileAfter) await sleep(1000);
}
if (!aFileAfter) throw new Error("会话 A 未出现在列表");

// ---- 切回 A：响应完整保留 ----
const backA = await b.openSession(aFileAfter);
if (path.resolve(backA.sessionFile) !== path.resolve(aFileAfter)) throw new Error("切回 A 后焦点不是 A");
const msgsA = b.snapshotMessages();
const lastA = msgsA.filter((m) => m.role === "assistant").pop();
const textA = (lastA?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
if (!textA.trim()) throw new Error("会话 A 响应不完整: " + textA.slice(0, 80));
console.log("A response preserved after switching away:", textA.slice(0, 60));

// ---- 再切回 B ----
const backB = await b.openSession(stB.sessionFile);
if (path.resolve(backB.sessionFile) !== path.resolve(stB.sessionFile)) throw new Error("再切回 B 失败");
const msgsB = b.snapshotMessages();
const lastB = msgsB.filter((m) => m.role === "assistant").pop();
const textB = (lastB?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
if (!textB.trim()) throw new Error("会话 B 响应不完整: " + textB.slice(0, 80));
console.log("A <-> B switching works, B response:", textB.slice(0, 60));

// ---- 会话共存于池 + 列表标记 ----
const list = await b.listSessions();
const aInList = list.some((s) => path.resolve(s.file) === path.resolve(stA0.sessionFile));
const bInList = list.some((s) => path.resolve(s.file) === path.resolve(stB.sessionFile));
if (!aInList || !bInList) throw new Error("双会话未共存于列表");
console.log("both sessions coexist in list, running flags:", list.filter((s) => aInList && path.resolve(s.file) === path.resolve(stA0.sessionFile) || bInList && path.resolve(s.file) === path.resolve(stB.sessionFile)).map((s) => s.running));

// ---- 清理 ----
await b.dispose();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("MULTISESSION VERIFY OK");
