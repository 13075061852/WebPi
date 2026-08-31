/**
 * UI 预览截图工具（开发用）：
 *   node test/ui-preview.mjs
 * 生成 __preview.html（index.html + window.halo 桩 + 场景事件），
 * 用 headless Edge + CDP 截取 黑 / 白 / 星环 / 网关停滞 四张图到 test/ui-*.png。
 * 不影响真实应用（独立 user-data-dir）。
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 8377;

const html = readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");

const stub = `<style>
  /* deterministic shots: skip entrance choreography */
  .fx { opacity: 1 !important; animation: none !important; }
</style>
<script>
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = q.get("theme") === "light" ? "light" : "dark";
  let piCb = null;
  window.halo = {
    getState: async () => ({ data: {
      cwd: "D:\\\\GitHub\\\\WebPi", ready: true, isStreaming: false,
      model: { name: "GPT-5.6 Sol", provider: "openai-codex", contextWindow: 272000 },
      thinkingLevel: "medium",
      usage: { input: 1284, output: 3420, cacheRead: 18200, cacheWrite: 260, cost: 0.0123 },
      messageCount: 6, sessionFile: "D:\\\\s\\\\2025-08-29-ink-paper-retheme.jsonl",
    }}),
    listSessions: async () => ({ data: [
      { file: "a.jsonl", name: "重构黑白主题样式", modified: Date.now(), messageCount: 12 },
      { file: "b.jsonl", name: "修复文件树排序", modified: Date.now() - 86400000, messageCount: 4 },
    ]}),
    listResources: async () => ({ data: {
      skills: [{ name: "edge-tts", description: "TTS" }, { name: "council-mode", description: "" }],
      prompts: [{ name: "review", description: "" }],
      extensions: [
        { name: "wechat-bridge.js", path: "C:\\pi\\extensions\\wechat-bridge.js", disabled: false },
        { name: "todo-tracker.js", path: "C:\\pi\\extensions\\todo-tracker.js", disabled: true },
      ],
    }}),
    extToggle: async () => ({ ok: true, data: (await window.halo.listResources()).data }),
    authProviders: async () => ({ ok: true, data: [
      { id: "openai-codex", name: "OpenAI Codex", canOAuth: true, canApiKey: true, subscription: true, configured: true, source: "stored" },
      { id: "deepseek", name: "DeepSeek", canOAuth: false, canApiKey: true, subscription: false, configured: true, source: "stored" },
      { id: "kimi-coding", name: "Kimi Coding", canOAuth: true, canApiKey: false, subscription: true, configured: false },
      { id: "anthropic", name: "Anthropic", canOAuth: true, canApiKey: true, subscription: true, configured: false },
    ]}),
    readTree: async () => ({ data: { root: "D:\\\\GitHub\\\\WebPi", tree: [
      { name: "src", path: "src", dir: true, size: 0 },
      { name: "main", path: "src\\\\main", dir: true, size: 0 },
      { name: "main.mjs", path: "src\\\\main\\\\main.mjs", dir: false, size: 9400 },
      { name: "renderer", path: "src\\\\renderer", dir: true, size: 0 },
      { name: "app.css", path: "src\\\\renderer\\\\css\\\\app.css", dir: false, size: 31400 },
      { name: "app.js", path: "src\\\\renderer\\\\js\\\\app.js", dir: false, size: 38200 },
      { name: "package.json", path: "package.json", dir: false, size: 389 },
      { name: "README.md", path: "README.md", dir: false, size: 4399 },
    ]}}),
    readFile: async () => ({ data: "" }),
    listModels: async () => ({ data: [] }),
    onPiEvent: (cb) => { piCb = cb; },
    onState: () => {}, onError: () => {}, onWinState: () => {},
  };
  window.__haloDispatch = (evt) => piCb && piCb(evt);
</script>`;

const scenario = `<script type="module">
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1200);
  const q = new URLSearchParams(location.search);
  const d = window.__haloDispatch;
  if (q.get("case") === "auth") {
    document.querySelector("#authBtn").click();
    await sleep(600);
    d({ type: "auth_event", phase: "prompt", providerId: "openai-codex",
        prompt: { type: "select", message: "Select OpenAI Codex login method:",
          options: [{ id: "browser", label: "Browser login (default)" }, { id: "device", label: "Device code login (headless)" }] } });
    if (q.get("af")) document.querySelector('#authFilters [data-af="' + q.get("af") + '"]').click();
    document.title = "preview-auth";
  }
  d({ type: "agent_start" });
  if (q.get("case") === "caps") {
    document.querySelector('[data-tab="skills"]').click();
    document.title = "preview-caps";
  }
  await sleep(400);
  if (q.get("case") === "stall") {
    /* gateway goes silent: placeholder + stall hint become visible */
    document.title = "preview-stall";
    await sleep(20000);
  }
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  for (const ch of ["用户想把主题改成黑白双色。", "统一令牌，去掉彩色光晕。"]) {
    d({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: ch } });
    await sleep(100);
  }
  const t1 = "我先看一下项目的目录结构，再决定怎么做。";
  for (const w of t1.split("")) d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: w } });
  d({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: t1 }], stopReason: "toolUse" } });
  await sleep(200);
  d({ type: "tool_execution_start", toolCallId: "t1", toolName: "write", args: { path: "src/renderer/css/app.css" } });
  await sleep(600);
  d({ type: "tool_execution_end", toolCallId: "t1", isError: false,
      result: { content: [{ type: "text", text: "- --acc-a: #8be9ff;\\n+ --acc: #ffffff;\\n- --grad: linear-gradient(...);\\n+ --acc-ink: #0b0b0c;" }] } });
  await sleep(250);
  d({ type: "message_start", message: { role: "assistant", content: [] } });
  const t2 = "**主题已重构**为黑白双色：\\n\\n- 令牌统一为单色墨水\\n- 明暗两套主题，右上角一键切换\\n- 星环画布同步单色化";
  for (const w of t2.split("")) d({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: w } });
  d({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: t2 }], stopReason: "endTurn", usage: { input: 1200, output: 340, cacheRead: 8200, cacheWrite: 260, cost: { total: 0.0123 } } } });
  d({ type: "agent_end", messages: [], willRetry: false });
  d({ type: "agent_settled" });
  d({ type: "queue_update", steering: ["发送按钮改成描边样式"], followUp: [] });
  document.title = "preview-ready";
</script>`;

const out = html
  .replace('href="css/app.css"', 'href="../src/renderer/css/app.css"')
  .replace('src="js/app.js"', 'src="../src/renderer/js/app.js"')
  .replace('<script type="module" src="../src/renderer/js/app.js">', stub + '\n<script type="module" src="../src/renderer/js/app.js">')
  .replace("</body>", scenario + "\n</body>");
writeFileSync(path.join(ROOT, "test/__preview.html"), out);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\//, "");
  try {
    const p = path.join(ROOT, rel);
    res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
    res.end(readFileSync(p));
  } catch {
    res.statusCode = 404; res.end("NOT_FOUND:" + rel);
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const DBG = 8378;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${path.join(ROOT, "test/.edge-tmp")}`,
  "--remote-debugging-port=" + DBG,
  "--window-size=1680,1000",
  "about:blank",
], { stdio: "ignore" });

async function findPage() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(400);
  }
  throw new Error("no page");
}
const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
await send("Page.enable");
await send("Runtime.enable");

const shots = [
  ["dark", "test/ui-dark.png"],
  ["light", "test/ui-light.png"],
  ["light&case=stall", "test/ui-stall.png"],
  ["dark&case=auth", "test/ui-auth.png"],
  ["dark&case=auth&af=oauth", "test/ui-auth-oauth.png"],
  ["dark&case=caps", "test/ui-caps.png"],
];
for (const [q, file] of shots) {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/test/__preview.html?theme=${q}` });
  let theme = "", ready = "";
  const wantHint = file.includes("stall");
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await send("Runtime.evaluate", { expression: "document.title + '|' + document.documentElement.dataset.theme + '|' + !!document.getElementById('stallHint')", returnByValue: true });
    const v = r.result?.result?.value || "";
    const [rd, th, hint] = v.split("|");
    ready = rd; theme = th;
    if (ready.startsWith("preview-") && (!wantHint || hint === "true")) break;
  }
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) writeFileSync(path.join(ROOT, file), Buffer.from(r.result.data, "base64"));
  console.log("shot:", file, r.result?.data ? "ok" : "FAIL", "| theme=" + theme, "| state=" + ready);
}
ws.close();
edge.kill();
server.close();
rmSync(path.join(ROOT, "test/__preview.html"), { force: true });
setTimeout(() => rmSync(path.join(ROOT, "test/.edge-tmp"), { recursive: true, force: true }), 3000).unref?.();
console.log("done");
