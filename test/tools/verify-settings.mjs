import fs from "node:fs";
import path from "node:path";
const PORT = process.argv[2] || "9371";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS = path.join(process.env.USERPROFILE || "C:/Users/13087", ".pi", "agent", "settings.json");
const readPkgs = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")).packages || []; } catch { return []; } };
const before = readPkgs();
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
  if (r.result?.exceptionDetails) console.log("PAGE ERR:", JSON.stringify(r.result.exceptionDetails).slice(0, 240));
  return r.result?.result?.value;
});
await send("Runtime.enable");
await sleep(3200);

// 1. 左下角结构
const s1 = await ev('({ hasSettings: !!document.getElementById("btnSettings"), hasAuth: !!document.getElementById("authBtn"), modelSummaryGone: !document.getElementById("authSummary") })');
console.log("1. bottom bar:", JSON.stringify(s1));

// 2. 打开设置 + 已安装列表
await ev('document.getElementById("btnSettings").click()');
await sleep(900);
const s2 = await ev('({ modalShown: document.getElementById("settingsModal").classList.contains("show"), installedRows: document.querySelectorAll("#pkgInstalled .pkg-row").length, first: document.querySelector("#pkgInstalled .pkg-name")?.textContent })');
console.log("2. settings open:", JSON.stringify(s2));

// 3. 市场搜索（npm registry 网络）
await sleep(2500);
const s3 = await ev('({ cards: document.querySelectorAll("#pkgMarket .pkg-card").length, total: document.getElementById("pkgTotal")?.textContent, sample: [...document.querySelectorAll("#pkgMarket .pkg-card .pkg-name")].slice(0, 5).map((e) => e.textContent) })');
console.log("3. market:", JSON.stringify(s3));

// 4. 类型 tab 过滤
await ev('[...document.querySelectorAll("#pkgTabs .ptab")].find((b) => b.dataset.t === "skill").click()');
await sleep(600);
const s4 = await ev('({ skillCards: document.querySelectorAll("#pkgMarket .pkg-card").length, badgeOk: [...document.querySelectorAll("#pkgMarket .pkg-type")].every((e) => e.classList.contains("t-skill")) })');
console.log("4. skill tab:", JSON.stringify(s4));

// 5. toggle 回写测试（直接调 IPC，测后恢复）
const raw = before[0];
if (raw && typeof raw === "string") {
  await ev('window.halo.pkgToggle(' + JSON.stringify(raw) + ', false)');
  const off = readPkgs();
  const offEntry = off.find((p) => (typeof p === "string" ? p : p.source) === raw);
  const offOk = typeof offEntry === "object" && offEntry.extensions?.length === 0;
  await ev('window.halo.pkgToggle(' + JSON.stringify(raw) + ', true)');
  const on = readPkgs();
  const onOk = on.find((p) => (typeof p === "string" ? p : p.source) === raw) === raw;
  console.log("5. toggle:", JSON.stringify({ offOk, onOk, restored: JSON.stringify(on) === JSON.stringify(before) }));
} else {
  console.log("5. toggle: SKIP (first package is not a plain string)");
}
process.exit(0);
// 6. 截图留档（设置面板打开状态）
await ev('document.getElementById("btnSettings").click()');
await sleep(800);
await ev('[...document.querySelectorAll("#pkgTabs .ptab")].find((b) => b.dataset.t === "all").click()');
await sleep(2200);
const rr = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("test/shot-settings.png", Buffer.from(rr.result.data, "base64"));
console.log("6. shot saved: test/shot-settings.png");
process.exit(0);
