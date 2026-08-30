/* ============================================================
   Pi Halo — app orchestration (v2, hardened)
   Maps pi SDK session events onto the celestial UI.
   Event truths verified against pi 0.84.4:
   - message_start/end fire for user AND assistant messages
   - assistant message carries stopReason / errorMessage
   - agent_end carries willRetry; retry loop ends with agent_settled
   ============================================================ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// 预览帧触摸脚本回报滚动位置（调试/验证用）
window.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.__haloScroll) window.__haloTouchState = d.__haloScroll;
  if (d && d.__haloOs) window.__haloOs = d.__haloOs;
});

const S = {
  state: null,
  streaming: false,
  streamingTool: null,
  retrying: null,             // {attempt, maxAttempts} | null
  images: [],                 // pending attachments [{name, mediaType, data}]
  lastUserPrompt: null,       // for retry button
  models: [],
  resources: { skills: [], prompts: [], extensions: [] },
  assistant: null,            // current per-message body inside the turn container
  turn: null,                 // Claude-style turn block: one avatar, content flows downward
  assistantText: "",
  thinking: null,
  toolCards: new Map(),       // toolCallId -> {card, outEl, descEl, path, startedAt, toolName}
  queued: { steering: [], followUp: [] },
  pkgQuery: "", pkgType: "all", pkgFrom: 0, pkgItems: [], pkgTotal: 0, pkgLoaded: false, pkgInstalledList: [],
  previewMode: "render", // 预览模式：render（渲染页面）| source（源代码）
  sessions: [],
  renderQueued: false,
  agentStartedAt: 0,
  lastEventAt: 0,             // stall watchdog: last pi event timestamp
  stallTimer: null,
  /* workspace / preview */
  activity: [],               // [{path, tool, time, diff}]
  treeData: null,
  expanded: new Set(),        // expanded folder paths
  selectedFile: null,
  previewFile: null,
  treeTimer: null,
  creating: null,             // { parent: string|null, kind: "file"|"dir" } 行内新建状态
};

const TOOL_ICONS = {
  read: "◈", write: "✎", edit: "✧", bash: "❯", powershell: "❯",
  grep: "⌕", find: "⌕", ls: "▤", todo: "☑",
};
const TOOL_COLORS = {
  read: "var(--txt-dim)", bash: "var(--txt)", powershell: "var(--txt)", edit: "var(--txt-dim)",
  write: "var(--txt)", grep: "var(--txt-dim)", find: "var(--txt-dim)", ls: "var(--txt-faint)",
};

/* ---------- theme: 黑 / 白 ---------- */
function applyTheme(t, { persist = true } = {}) {
  document.documentElement.dataset.theme = t === "light" ? "light" : "dark";
  if (persist) { try { localStorage.setItem("halo-theme", document.documentElement.dataset.theme); } catch {} }
  document.dispatchEvent(new CustomEvent("themechange"));
}

/* ============================================================
   boot
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  requestAnimationFrame(() => document.body.classList.add("enter"));
  wireUI();
  wirePi();
  refreshAll();
  updateAuthSummary();
  loadTree();
  // 对齐分割线：sidebar 登录区顶线与预览区下方设备切换条顶线在同一水平线
  const devicesBar = document.querySelector(".pv-devices"), modelCard = $("#modelCard");
  if (devicesBar && modelCard && window.ResizeObserver) {
    const syncFoot = () => { modelCard.style.minHeight = devicesBar.offsetHeight + "px"; };
    new ResizeObserver(syncFoot).observe(devicesBar);
    syncFoot();
  }
});

async function refreshAll() {
  const st = await window.halo.getState();
  applyState(st?.data || st);
  loadProjects();
  await Promise.all([loadSessions(), loadResources()]);
  // 等核心 ready 后再恢复工作区（bridge 未就绪时 openSession 会被忽略）
  if ((st?.data || st)?.ready) {
    await restoreWorkspace();
    // 无论是否走了恢复分支，都按当前 cwd 强刷一次文件树（冷启动时没人加载过它）
    await loadTree(true);
  } else S.pendingRestore = true;
}

/* ============================================================
   state application
   ============================================================ */
function applyState(st) {
  if (!st) return;
  S.state = st;
  if (st.sessionFile) saveWorkspace();
  if (st.cwd) {
    const name = st.cwd.split(/[\\/]/).filter(Boolean).pop() || st.cwd;
    $("#projectName").textContent = name;
    $("#projectChip").title = st.cwd;
  }
  const m = st.model;
  $("#modelChipName").textContent = m ? m.name : "模型";

  const tl = st.thinkingLevel || "off";

  $("#thinkChip").textContent = THINK_LABELS[tl] || tl;

  renderStats(st.usage);

  const ready = !!st.ready;
  $("#input").placeholder = ready
    ? "描述你要完成的任务…  Enter 发送 · Shift+Enter 换行"
    : "核心唤醒中，请稍候…";
  $("#btnSend").disabled = !ready;
  $("#btnSend").classList.toggle("dim", !ready);

  setStreamingUI(st.isStreaming || S.streaming);

  if (st.ready && S.pendingRestore) {
    S.pendingRestore = false;
    restoreWorkspace();
  }
}

function renderStats(u = {}) {
  const allZero = !u.input && !u.output && !u.cacheRead && !u.cacheWrite && !u.cost;
  $("#chatStats").innerHTML = allZero
    ? `<span title="当前网关未返回用量统计">— tokens</span><span title="花费">— $</span>`
    : `<span title="输入 tokens">↑ ${fmtTokens(u.input)}</span>` +
      `<span title="输出 tokens">↓ ${fmtTokens(u.output)}</span>` +
      `<span title="缓存读取">R ${fmtTokens(u.cacheRead)}</span>` +
      `<span title="缓存写入">W ${fmtTokens(u.cacheWrite)}</span>` +
      `<span title="花费">$${(u.cost || 0).toFixed(4)}</span>`;
}

const THINK_LABELS = {
  off: "关闭", minimal: "极简", low: "低", medium: "中",
  high: "高", xhigh: "超高", max: "最大",
};
const THINK_DESC = {
  off: "直接回答", minimal: "少量思考", low: "轻量思考", medium: "平衡模式",
  high: "深度推理", xhigh: "极限推理", max: "火力全开",
};

/* "2026-08-29T08-06-20-270Z_01a04c89-…" -> "08-29 08:06 · a04c89" */
function friendlySession(file) {
  const m = file.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
  const uid = (file.match(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) || [])[1];
  if (m && uid) return `${m[2]}-${m[3]} ${m[4]}:${m[5]} · ${uid.slice(0, 6)}`;
  if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  return file.length > 28 ? file.slice(0, 25) + "…" : file;
}

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function setStreamingUI(v) {
  S.streaming = v;
  $("#btnSend").classList.toggle("streaming", v);
  $("#btnSend").title = v ? "中止 (Esc)" : "发送";
  if (v) { startStallWatchdog(); startStatusTicker(); }
  else { stopStallWatchdog(); stopStatusTicker(); }
  updateTurnStatus();
}

/* ---- stall watchdog: surface silent gateways instead of looking frozen ---- */
const STALL_MS = 10000;
function startStallWatchdog() {
  stopStallWatchdog();
  S.lastEventAt = Date.now();
  S.stallTimer = setInterval(() => {
    const idle = Date.now() - S.lastEventAt;
    if (idle >= STALL_MS) showStallHint(Math.floor(idle / 1000));
  }, 1000);
}
function stopStallWatchdog() {
  if (S.stallTimer) { clearInterval(S.stallTimer); S.stallTimer = null; }
  hideStallHint();
}
function showStallHint(sec) {
  let el = $("#stallHint");
  if (!el) {
    el = document.createElement("div");
    el.id = "stallHint";
    el.className = "stall-hint";
    (S.turn || $("#messages")).appendChild(el);
  }
  el.innerHTML = `<span class="s-dot"></span>网关已 ${sec}s 无响应 · 仍在等待，可按 Esc 中止`;
}
function hideStallHint() { const el = $("#stallHint"); if (el) el.remove(); }

/* ============================================================
   pi event stream -> UI
   ============================================================ */
function wirePi() {
  // lightweight diagnostics: real-link event tracing (visible via CDP)
  window.__piDebug = { count: 0, types: [] };
  window.halo.onPiEvent(({ event }) => {
    try {
      window.__piDebug.count++;
      window.__piDebug.types.push(event?.type);
      if (window.__piDebug.types.length > 200) window.__piDebug.types.shift();
    } catch {}
    handlePiEvent(event);
  });
  // debug/test hook: inject synthetic events without the main process
  window.__haloDispatch = handlePiEvent;
  window.__renderUserMsg = renderUserMsg;
  window.__mdRender = mdRender; // 调试/验证钩子
  window.halo.onState((st) => applyState(st));
  window.halo.onError?.((e) => toast(e?.message || "发生错误", "err"));
  window.halo.onWinState?.(({ maximized }) => {
    $("#winMax").title = maximized ? "还原" : "最大化";
    $("#winMax").classList.toggle("maxed", maximized);
  });
}

function handlePiEvent(event) {
  if (!event) return;
  S.lastEventAt = Date.now();
  hideStallHint();
  switch (event.type) {
      case "message_start": onMessageStart(event.message); break;
      case "message_update": onMessageUpdate(event.assistantMessageEvent); break;
      case "message_end": onMessageEnd(event.message); break;

      case "tool_execution_start": onToolStart(event); break;
      case "tool_execution_update": onToolUpdate(event); break;
      case "tool_execution_end": onToolEnd(event); break;

      case "agent_start":
        S.retrying = null;
        S.streamingTool = null;
        S.agentStartedAt = Date.now();
        setStreamingUI(true);
        ensureTurn(); // Claude 式回合块立即出现，头像只出现一次
        break;
      case "agent_end":
        S.streamingTool = null;
        finalizeMessage();
        if (!event.willRetry) { setStreamingUI(false); finalizeTurn(); }
        else setStreamingUI(true); // keep busy visual during retry gap
        refreshState();
        break;

      case "auto_retry_start":
        S.retrying = { attempt: event.attempt, maxAttempts: event.maxAttempts };
        toast(`请求失败，自动重试中 (${event.attempt}/${event.maxAttempts})`, "warn");
        setStreamingUI(true);
        break;
      case "auto_retry_end":
        S.retrying = null;
        if (!event.success) {
          setStreamingUI(false);
          renderFatalError(event.finalError || "请求失败");
          loadSessions();
        }
        break;
      case "agent_settled":
        S.retrying = null;
        setStreamingUI(false);
        finalizeMessage();
        finalizeTurn();
        refreshState();
        loadSessions();
        break;

      case "queue_update": {
        const had = S.queued.steering.length + S.queued.followUp.length;
        S.queued = { steering: event.steering || [], followUp: event.followUp || [] };
        renderQueue();
        if (S.queued.steering.length > had) toast("已入队引导消息", "ok");
        break;
      }
      case "compaction_start": toast("正在压缩上下文…", ""); break;
      case "compaction_end": toast("上下文已压缩 ✓", "ok"); break;
      case "auth_event": onAuthEvent(event); break;
    }
  }

  async function refreshState() {
  const st = await window.halo.getState();
  if (st?.data) applyState(st.data);
}

/* ---- Claude-style turn block ----
 * 一轮回答一个块：头像只出现一次，正文（无气泡）/ 思考（折叠行）/ 工具（轻量行）
 * 按时间顺序连排向下。 */
function ensureTurn() {
  if (S.turn) return S.turn;
  const wrap = document.createElement("div");
  wrap.className = "turn";
  wrap.__texts = []; // 本轮各段原始文本
  wrap.innerHTML = `
    <div class="turn-status" hidden>
      <span class="pi-orb">π</span>
      <span class="turn-status-text">正在思考…</span>
      <span class="turn-status-hint">Esc 中止</span>
    </div>`;
  $("#messages").appendChild(wrap);
  S.turn = wrap;
  scrollDown();
  return wrap;
}

function finalizeTurn() {
  const turn = S.turn;
  S.turn = null;
  if (!turn) return;
  // 回合结束，等待动画随之消失
  $(".turn-status", turn)?.remove();
  // 空回合（没有任何实质内容）直接移除
  if (!$(".md, .think, .tool, .error-card, .stall-hint", turn)) { turn.remove(); return; }
}

/* 回合内等待状态：π 动画图标 + 当前动作 + Esc 提示（行首，替代文末光标） */
let _statusTimer = null;
function turnStatusText() {
  if (S.retrying) return `自动重试中 (${S.retrying.attempt}/${S.retrying.maxAttempts})`;
  if (S.streamingTool) return `正在执行 ${S.streamingTool}`;
  if (S.assistant) return "正在回复…";
  if (S.streaming) return "正在思考…";
  return "";
}
function updateTurnStatus() {
  const row = S.turn && $(".turn-status", S.turn);
  if (!row) return;
  const txt = turnStatusText();
  row.hidden = !txt;
  if (txt) $(".turn-status-text", row).textContent = txt;
}
function startStatusTicker() {
  if (_statusTimer) return;
  _statusTimer = setInterval(updateTurnStatus, 500);
}
function stopStatusTicker() {
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
}

/* 思考过程：折叠为一行「◆ 思考 Ns」，点击展开斜体浅色内容 */
function ensureThink() {
  if (S.thinking) return S.thinking;
  const d = document.createElement("details");
  d.className = "think";
  d.innerHTML = `<summary><span class="diamond">◆</span><span class="think-label">思考中…</span><span class="think-preview"></span></summary><div class="think-body"></div>`;
  ensureTurn().appendChild(d);
  d.open = true;
  S.thinking = { el: d, body: $(".think-body", d), label: $(".think-label", d), preview: $(".think-preview", d), buf: "", t0: Date.now() };
  return S.thinking;
}

const thinkPreviewText = (buf) =>
  String(buf).replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 260);

function collapseThink() {
  const t = S.thinking;
  if (!t) return;
  const secs = Math.max(1, Math.round((Date.now() - t.t0) / 1000));
  t.label.textContent = `思考 ${secs}s`;
  t.preview.textContent = thinkPreviewText(t.buf);
  t.el.open = false;
  S.thinking = null;
}

/* 正文块：第一条文本到达时才创建 —— 没有空气泡、没有占位符 */
function ensureTextBlock() {
  if (S.assistant) return S.assistant;
  const md = document.createElement("div");
  md.className = "md";
  ensureTurn().appendChild(md);
  S.assistant = md;
  return md;
}

function finalizeMessage() {
  collapseThink();
  if (S.assistant) {
    // 最终渲染：去掉流式光标
    S.assistant.innerHTML = rich(S.assistantText);
    if (S.assistantText.trim() && S.turn) S.turn.__texts.push(S.assistantText);
  }
  S.assistant = null;
  S.assistantText = "";
}

function onMessageStart(msg) {
  if (!msg || msg.role !== "assistant") return; // user messages are rendered locally
  S.assistantText = "";
  collapseThink(); // 上一条消息残留的思考阶段收起，不能直接丢弃
}

function onMessageUpdate(ev) {
  if (!ev) return;
  if (ev.type === "text_delta") {
    collapseThink(); // 文本开始输出时把思考折叠为一行
    ensureTextBlock();
    S.assistantText += ev.delta || "";
    scheduleRender();
  } else if (ev.type === "thinking_delta") {
    const t = ensureThink();
    t.buf += ev.delta || "";
    t.body.innerHTML = rich(t.buf);
    t.preview.textContent = thinkPreviewText(t.buf); // 收起后单行预览实时跟随
    t.body.scrollTop = t.body.scrollHeight;
    scrollDown();
  }
}

function onMessageEnd(msg) {
  if (!msg || msg.role !== "assistant") return;

  // A1: surface model errors that pi reports on the message itself
  if (msg.stopReason === "error" && msg.errorMessage) {
    finalizeMessage();
    renderModelError(msg.errorMessage, { provider: msg.provider, model: msg.model });
    refreshState();
    return;
  }

  // restore thinking from the final message when the stream never sent deltas
  if (!S.thinking && Array.isArray(msg.content)) {
    const think = msg.content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("");
    if (think.trim()) {
      const t = ensureThink();
      t.buf = think;
      t.body.innerHTML = rich(think);
      t.label.textContent = "思考过程";
      t.preview.textContent = thinkPreviewText(think);
      t.el.open = false;
      S.thinking = null;
    }
  }

  // A3: rebuild from final content if we never streamed
  if (!S.assistant && Array.isArray(msg.content)) {
    const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (text.trim()) { S.assistantText = text; ensureTextBlock(); }
  }
  finalizeMessage();
}

function scheduleRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => {
    S.renderQueued = false;
    renderAssistant();
  });
}

function renderAssistant() {
  const el = S.assistant;
  if (!el) return;
  el.innerHTML = rich(S.assistantText);
  scrollDown();
}

/* ---- error cards ---- */
function classifyError(msg = "") {
  const m = String(msg);
  if (/429|余额|资源包|quota|billing|insufficient/i.test(m))
    return { kind: "quota", hint: "当前模型额度不足或限流，可以切换到其他可用模型继续。" };
  if (/fetch failed|network|ECONN|timeout|socket|WebSocket/i.test(m))
    return { kind: "network", hint: "网络请求失败：请检查网络连接或代理设置（该模型可能需要科学上网）。" };
  if (/401|403|auth|unauthorized|api key|login/i.test(m))
    return { kind: "auth", hint: "鉴权失败：请重新登录或在环境变量中配置 API Key。" };
  return { kind: "generic", hint: null };
}

function renderModelError(raw, meta = {}) {
  const cls = classifyError(raw);
  const n = document.createElement("div");
  n.className = "error-card";
  n.innerHTML = `
    <div class="ec-head"><span class="ec-dot"></span><b>请求失败</b>
      <span class="ec-meta">${esc(meta.provider || "")}${meta.model ? " · " + esc(meta.model) : ""}</span></div>
    <div class="ec-hint">${esc(cls.hint || "")}</div>
    <div class="ec-raw">${esc(trunc(String(raw), 300))}</div>
    <div class="ec-actions">
      <button class="ec-retry">↻ 重试</button>
      ${cls.kind === "quota" ? `<button class="ec-model">切换模型</button>` : ""}
    </div>`;
  $(".ec-retry", n).addEventListener("click", () => {
    n.remove();
    retryLast();
  });
  const mb = $(".ec-model", n);
  if (mb) mb.addEventListener("click", () => { loadModels(); openModal("modelModal"); });
  (S.turn || $("#messages")).appendChild(n);
  scrollDown();
}

function renderFatalError(raw) {
  renderModelError(raw, {});
}

async function retryLast() {
  if (!S.lastUserPrompt) return toast("没有可重试的消息", "err");
  if (S.streaming) return toast("任务进行中", "err");
  const { text, images } = S.lastUserPrompt;
  renderUserMsg(text, images);
  try {
    await window.halo.prompt(text, images.length ? { images: images.map(toPiImage) } : {});
  } catch (e) { toast(`发送失败：${e?.message || e}`, "err"); }
}

/* ---- tool cards ---- */
function toolDesc(toolName, args = {}) {
  const a = args || {};
  switch (toolName) {
    case "read": case "write": case "edit": return a.path || "";
    case "bash": case "powershell": return a.command || a.cmd || "";
    case "grep": return `${a.pattern || ""}${a.path ? "  ·  " + a.path : ""}`;
    case "find": return a.pattern || a.path || "";
    case "ls": return a.path || ".";
    default: return Object.entries(a).slice(0, 2).map(([k, v]) => `${k}: ${trunc(String(v), 60)}`).join("  ·  ");
  }
}
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function onToolStart(ev) {
  const { toolCallId, toolName, args } = ev;
  collapseThink(); // 工具开跑前收起思考阶段，只留一行摘要
  S.streamingTool = toolName;
  setStreamingUI(true);

  // 轻量工具行：状态点 + 工具名 + 参数摘要 + 耗时，点击展开输出
  const card = document.createElement("div");
  card.className = "tool running";
  card.innerHTML = `
    <div class="tool-line">
      <span class="tool-dot"></span>
      <span class="tool-name">${esc(toolName)}</span>
      <span class="tool-arg">${esc(trunc(toolDesc(toolName, args), 120))}</span>
      <span class="tool-elapsed"></span>
    </div>
    <div class="tool-out" hidden></div>`;
  $(".tool-line", card).addEventListener("click", () => {
    const out = $(".tool-out", card);
    if (out.dataset.has) out.hidden = !out.hidden;
  });
  ensureTurn().appendChild(card);
  S.toolCards.set(toolCallId, {
    card,
    out: $(".tool-out", card),
    arg: $(".tool-arg", card),
    elapsedEl: $(".tool-elapsed", card),
    path: (args && (args.path || args.file)) || "",
    command: (args && (args.command || args.cmd)) || "",
    toolName,
    startedAt: Date.now(),
  });
  scrollDown();
}

function onToolUpdate(ev) {
  const rec = S.toolCards.get(ev.toolCallId);
  if (!rec) return;
  const args = ev.partial?.args || ev.args;
  if (args) rec.arg.textContent = trunc(toolDesc(rec.toolName, args), 120);
}

function onToolEnd(ev) {
  const { toolCallId, isError, result } = ev;
  const rec = S.toolCards.get(toolCallId);
  S.streamingTool = null;
  setStreamingUI(true);

  if (!rec) return;
  // elapsed + 状态点
  const secs = (Date.now() - rec.startedAt) / 1000;
  rec.elapsedEl.textContent = secs >= 0.5 ? `${secs.toFixed(1)}s` : "";
  rec.card.classList.remove("running");
  rec.card.classList.add(isError ? "error" : "done");

  let text = "";
  const contents = result?.content || [];
  for (const c of contents) if (c.type === "text") text += (text ? "\n" : "") + c.text;
  const diff = result?.details?.diff || result?.details?.patch;
  if (diff && !text) text = diff;

  // workspace: record session changes + refresh tree + auto-preview pages
  if (!isError && (rec.toolName === "write" || rec.toolName === "edit") && rec.path) {
    recordActivity({ path: rec.path, tool: rec.toolName, time: Date.now(), diff: diff ? String(diff).slice(0, 120000) : null });
    scheduleTreeRefresh();
    const ext = rec.path.split(".").pop().toLowerCase();
    if (ext === "html" || ext === "htm") {
      setPreview(rec.path);
      toast("已生成页面，已切换到预览", "ok");
    }
  }

  const out = rec.out;
  out.dataset.has = "1";
  if (diff) {
    out.innerHTML = esc(String(diff)).split("\n").map((l) => {
      if (l.startsWith("+") && !l.startsWith("+++")) return `<span class="diff-add">${l}</span>`;
      if (l.startsWith("-") && !l.startsWith("---")) return `<span class="diff-del">${l}</span>`;
      return l;
    }).join("\n");
  } else {
    out.textContent = text ? trunc(text, 4000) : (isError ? "（无输出）" : "（完成）");
  }
  if (isError) out.hidden = false; // B7: auto-expand failures
  scrollDown();
}

/* ---- notices / queue ---- */
function notice(text, kind = "") {
  // 重复消息过滤：与上一条提示文案相同时不再重复展示
  const all = $$("#messages .notice");
  const last = all[all.length - 1];
  if (last && last.textContent === text) return;
  const n = document.createElement("div");
  n.className = `notice ${kind}`;
  n.textContent = text;
  $("#messages").appendChild(n);
  scrollDown();
}

function renderQueue() {
  const row = $("#queueRow");
  const items = [
    ...S.queued.steering.map((t) => ({ t, k: "引导" })),
    ...S.queued.followUp.map((t) => ({ t, k: "追加" })),
  ];
  row.hidden = items.length === 0;
  row.innerHTML = items.map((i) =>
    `<div class="queue-chip"><small>${i.k}</small><span>${esc(trunc(i.t, 60))}</span></div>`).join("");
}

/* ============================================================
   user input / sending
   ============================================================ */
const toPiImage = (i) => ({
  // pi SDK 的规范图片形状是扁平的 {type, mimeType, data}（与 CLI 附件一致）。
  // 千万不能用 {source:{mediaType,data}} 嵌套形状 —— 适配器读 item.mimeType 会拿到 undefined。
  type: "image",
  mimeType: normImageMime(i.mediaType) || sniffImageMime(i.data) || "image/png",
  data: i.data,
});

async function send() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text && S.images.length === 0) return;

  if (S.streaming) {
    if (text.startsWith("/")) return toast("任务进行中，命令暂不可用", "err");
    await window.halo.steer(text);
    input.value = "";
    autoGrow();
    return;
  }

  if (!S.state?.ready) return toast("核心尚未就绪，请稍候", "err");

  // local commands (pi-side commands pass through)
  const lc = text.toLowerCase();
  if (lc === "/new") { input.value = ""; return newSession(); }
  if (lc === "/model") { input.value = ""; return openModal("modelModal"); }
  if (lc === "/thinking") { input.value = ""; return openModal("thinkModal"); }
  if (lc === "/compact" || lc.startsWith("/compact ")) {
    input.value = "";
    toast("压缩上下文中…");
    const r = await window.halo.compact(text.slice(8).trim() || undefined);
    if (r?.ok) toast("上下文已压缩 ✓", "ok");
    return;
  }
  if (lc === "/help") { input.value = ""; return openModal("helpModal"); }

  // A4: snapshot for rollback
  const sentImages = S.images.slice();
  renderUserMsg(text, sentImages);
  S.lastUserPrompt = { text, images: sentImages };
  S.images = [];
  renderAttachments();
  input.value = "";
  autoGrow();

  try {
    await window.halo.prompt(text, sentImages.length ? { images: sentImages.map(toPiImage) } : {});
  } catch (e) {
    toast(`发送失败：${e?.message || e}`, "err");
    // A4: rollback so the user doesn't lose their text
    input.value = text;
    S.images = sentImages;
    renderAttachments();
    autoGrow();
    setStreamingUI(false);
  }
}

function renderUserMsg(text, images) {
  // 对话开始后清掉遗留的系统提示，保持对话流只包含当前对话内容
  $$("#messages > .notice").forEach((n) => n.remove());
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const imgs = (images || []).map((i) =>
    `<img src="data:${i.mediaType};base64,${i.data}" title="${esc(i.name)}" />`).join("");
  wrap.innerHTML = `
    ${imgs ? `<div class="imgs">${imgs}</div>` : ""}
    ${text ? `<div class="bubble">${rich(text)}</div>` : ""}`;
  $("#messages").appendChild(wrap);
  scrollDown(true);
}

function abort() {
  window.halo.abort();
  S.retrying = null;
  toast("已请求中止");
}

/* ============================================================
   history restore
   ============================================================ */
async function restoreHistory() {
  const r = await window.halo.snapshotMessages();
  const msgs = r?.data || [];
  if (!msgs.length) return;
  for (const m of msgs) {
    const text = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (!text.trim()) continue;
    if (m.role === "user") { finalizeTurn(); renderUserMsg(text, []); }
    else if (m.role === "assistant") {
      // 连续的 assistant 消息合入同一个回合块，与实时渲染保持一致
      const turn = ensureTurn();
      const md = document.createElement("div");
      md.className = "md";
      md.innerHTML = rich(text);
      turn.appendChild(md);
      turn.__texts.push(text);
    }
  }
  finalizeTurn();
  scrollDown();
}

/* ============================================================
   sessions / resources / models
   ============================================================ */
async function loadSessions() {
  const r = await window.halo.listSessions();
  S.sessions = r?.data || [];
  const list = $("#sessionList");
  if (!S.sessions.length) {
    list.innerHTML = `<div class="res-empty">当前项目还没有会话</div>`;
    return;
  }
  list.innerHTML = "";
  for (const s of S.sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    const file = (s.file || "").split(/[\\/]/).pop().replace(/\.jsonl$/, "");
    const main = document.createElement("button");
    main.className = "s-main";
    main.innerHTML = `<span class="s-name">${esc(s.name || friendlySession(file))}</span>
      <span class="s-meta">${s.modified ? new Date(s.modified).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}${s.messageCount != null ? " · " + s.messageCount + "条" : ""}</span>`;
    main.addEventListener("click", () => {
      if (S.streaming) return toast("任务进行中，无法切换会话", "err");
      openSession(s.file);
    });
    const del = document.createElement("button");
    del.className = "s-del";
    del.title = "删除会话";
    del.innerHTML = `<svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>`;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      requestDeleteSession(s, item, del);
    });
    item.append(main, del);
    list.appendChild(item);
  }
}

/* 删除会话：两步确认，避免误删；删除当前会话时先切到新会话 */
function requestDeleteSession(s, item, del) {
  if (!item.classList.contains("confirm")) {
    item.classList.add("confirm");
    del.title = "再次点击确认删除";
    clearTimeout(item._confirmTimer);
    item._confirmTimer = setTimeout(() => {
      item.classList.remove("confirm");
      del.title = "删除会话";
    }, 2600);
    return;
  }
  clearTimeout(item._confirmTimer);
  const isCurrent = normPath(S.state?.sessionFile || "") === normPath(s.file || "");
  if (isCurrent && S.streaming) return toast("任务进行中，先按 Esc 中止再删除", "err");
  del.disabled = true;
  window.halo.deleteSession(s.file)
    .then((r) => {
      if (!r?.ok) throw new Error(r?.error || "删除失败");
      if (r.data?.switched) {
        clearChat();
        toast("已删除当前会话，已开启新会话", "ok");
      } else {
        toast("会话已删除", "ok");
      }
      loadSessions();
    })
    .catch((e) => {
      del.disabled = false;
      toast(`删除失败：${e?.message || e}`, "err");
    });
}

const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();

/* ---- 工作区记忆：关闭时记住项目 + 当前会话，下次启动恢复到关闭时状态 ---- */
function saveWorkspace() {
  try {
    localStorage.setItem("halo-workspace", JSON.stringify({
      cwd: S.state?.cwd || "",
      session: S.state?.sessionFile || "",
    }));
  } catch {}
}
async function restoreWorkspace() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("halo-workspace") || "null"); } catch {}
  if (!saved || !saved.cwd) return;
  // 恢复项目目录
  if (normPath(saved.cwd) !== normPath(S.state?.cwd || "")) {
    const r = await window.halo.useProject(saved.cwd);
    if (!r?.ok) return;
    await applyProjectReset();
    await loadTree(true);
    await loadSessions();
    await loadResources();
  }
  // 恢复上次会话
  if (saved.session && normPath(saved.session) !== normPath(S.state?.sessionFile || "")) {
    const hit = S.sessions.find((s) => normPath(s.file) === normPath(saved.session));
    if (hit) {
      await window.halo.openSession(hit.file);
      await restoreHistory();
      toast("已恢复上次的会话", "ok");
    }
  }
}

async function openSession(file) {
  try {
    clearChat();
    await window.halo.openSession(file);
    await restoreHistory();
    toast("已切换会话", "ok");
  } catch (e) {
    toast(`打开失败：${e?.message || e}`, "err");
  }
}

async function newSession() {
  if (S.streaming) return toast("任务进行中，先按 Esc 中止", "err");
  clearChat();
  await window.halo.newSession();
  toast("新会话已开启", "ok");
  loadSessions();
}

function clearChat() {
  $("#messages").innerHTML = "";
  S.toolCards.clear();
  S.assistant = null;
  S.turn = null;
  S.assistantText = "";
  S.lastUserPrompt = null;
  S.activity = [];
}

async function loadResources() {
  const r = await window.halo.listResources();
  S.resources = r?.data || { skills: [], prompts: [], extensions: [] };
  renderResources();
}

function renderResources() {
  const fill = (sel, arr, fmt) => {
    const el = $(sel);
    if (!arr.length) { el.innerHTML = `<div class="res-empty">—</div>`; return; }
    el.innerHTML = arr.map(fmt).join("");
  };
  fill("#skillList", S.resources.skills, (s) => `<button class="res-chip" title="${esc(s.description || s.name)}" data-skill="${esc(s.name)}">✦ ${esc(s.name)}</button>`);
  fill("#promptList", S.resources.prompts, (p) => `<button class="res-chip" data-prompt="${esc(p.name)}" title="${esc(p.description || "")}">◈ ${esc(p.name)}</button>`);
  const extEl = $("#extList");
  const exts = S.resources.extensions || [];
  if (!exts.length) { extEl.innerHTML = `<div class="res-empty">—</div>`; }
  else {
    extEl.innerHTML = exts.map((x) => `
      <div class="ext-row" title="${esc(x.path)}">
        <span class="ext-name">⬡ ${esc(x.name)}</span>
        <button class="ext-switch${x.disabled ? "" : " on"}" data-ext-toggle="${esc(x.path)}" aria-label="扩展开关"></button>
      </div>`).join("");
  }
  extEl.querySelectorAll("[data-ext-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      const p = b.dataset.extToggle;
      const on = !b.classList.contains("on");
      b.disabled = true;
      const r = await window.halo.extToggle(p, on).catch((e) => ({ error: String(e) }));
      if (r?.error) { toast(`切换失败：${r.error}`, "err"); b.disabled = false; return; }
      S.resources = r?.data || S.resources;
      renderResources();
      clearChat();
      await restoreHistory();
      toast(on ? "扩展已开启（会话已重载）" : "扩展已关闭（会话已重载）", "ok");
    }));

  $("#skillList").querySelectorAll("[data-skill]").forEach((b) =>
    b.addEventListener("click", () => { $("#input").value = `/skill:${b.dataset.skill} `; $("#input").focus(); }));
  $("#promptList").querySelectorAll("[data-prompt]").forEach((b) =>
    b.addEventListener("click", () => { $("#input").value = `/${b.dataset.prompt} `; $("#input").focus(); }));
}

/* ---- models ---- */
async function loadModels() {
  const [r, dr] = await Promise.all([window.halo.listModels(), window.halo.defaultModelGet().catch(() => ({}))]);
  S.models = (r?.data || []).filter((m) => !m.error);
  S.defaultModel = dr?.data || "";
  renderModelList("");
}
function renderModelList(q) {
  const list = $("#modelList");
  const models = S.models.filter((m) =>
    !q || (m.name + m.id + m.provider).toLowerCase().includes(q.toLowerCase()));
  if (!models.length) {
    list.innerHTML = `<div class="model-empty">${S.models.length ? "没有匹配的模型" :
      "尚未发现可用模型<br>请先通过 pi 完成登录：<br><code style='font-family:var(--mono)'>~/.pi/agent/auth.json</code> 或环境变量 API Key</div>"}`;
    return;
  }
  const groups = new Map();
  for (const m of models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  list.innerHTML = "";
  for (const [prov, ms] of groups) {
    const g = document.createElement("div");
    g.className = "model-group-label";
    g.textContent = prov;
    list.appendChild(g);
    for (const m of ms) {
      const cur = S.state?.model;
      const key = m.provider + "/" + m.id;
      const isCur = cur && cur.provider === m.provider && cur.id === m.id;
      const isDef = S.defaultModel === key;
      const b = document.createElement("button");
      b.className = "model-item" + (isCur ? " current" : "");
      b.innerHTML = `
        <span class="mi-check">${isCur ? "●" : ""}</span>
        <span><div class="mi-name">${esc(m.name)}</div><div class="mi-id">${esc(m.provider)}/${esc(m.id)}</div></span>
        <span class="mi-meta">${m.reasoning ? "reasoning · " : ""}${fmtTokens(m.contextWindow)}
          <button class="mi-def${isDef ? " on" : ""}" data-key="${esc(key)}" title="设为默认模型（新会话自动使用）">${isDef ? "★ 默认" : "☆ 设默认"}</button>
        </span>`;
      b.querySelector(".mi-def").addEventListener("click", async (e) => {
        e.stopPropagation();
        const key = e.currentTarget.dataset.key; // await 前同步取值（await 后 currentTarget 为 null）
        const r = await window.halo.defaultModelSet(key);
        if (r?.ok) {
          S.defaultModel = key;
          renderModelList($("#modelSearch").value || "");
          toast(`默认模型已设置：${m.name}`, "ok");
        } else toast(`设置失败：${r?.error || ""}`, "err");
      });
      b.addEventListener("click", async () => {
        const r = await window.halo.setModel(m.provider, m.id);
        if (r?.ok) { applyState(r.data); closeModal(); toast(`已切换到 ${m.name}`, "ok"); }
        else toast(r?.error || "切换失败", "err");
      });
      list.appendChild(b);
    }
  }
}

/* ============================================================
   UI wiring
   ============================================================ */
function wireUI() {
  // window controls
  $("#winMin").addEventListener("click", () => window.halo.minimize());
  $("#winMax").addEventListener("click", () => window.halo.maximize());
  $("#winClose").addEventListener("click", () => window.halo.close());
  $("#themeToggle").addEventListener("click", () => {
    const root = document.documentElement;
    root.classList.add("theme-x");
    applyTheme(root.dataset.theme === "light" ? "dark" : "light");
    setTimeout(() => root.classList.remove("theme-x"), 320);
  });

  // sidebar tabs
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => {
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    const tab = btn.dataset.tab;
    $$(".side-section").forEach((p) => p.classList.toggle("active", p.dataset.pane === tab));
  }));

  // quick actions（快捷操作已移除，功能入口：新会话在会话页 / 模型在输入框旁 / compact、help 走斜杠命令）
  $("#btnNewSession").addEventListener("click", newSession);

  // auth card
  $("#authBtn").addEventListener("click", openAuthModal);

  // settings
  $("#btnSettings").addEventListener("click", openSettings);
  $$("#settingsModal .set-nav").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#settingsModal .set-nav").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll("#settingsModal .set-pane").forEach((p) => p.classList.toggle("active", p.id === "setPane-" + b.dataset.pane));
  }));
  $("#pkgSearchInput").addEventListener("input", debounce(() => { S.pkgQuery = $("#pkgSearchInput").value.trim(); loadMarket(true); }, 350));
  $("#pkgTabs").addEventListener("click", (e) => {
    const b = e.target.closest(".ptab");
    if (!b) return;
    S.pkgType = b.dataset.t;
    $$("#pkgTabs .ptab").forEach((x) => x.classList.toggle("active", x === b));
    loadMarket(true);
  });
  $("#pkgMore").addEventListener("click", () => loadMarket(false));
  $("#pkgUpdateAll").addEventListener("click", updateAllPkgs);
  $("#pkgApply").addEventListener("click", applyPkgChanges);
  $("#pkgInstalled").addEventListener("click", onInstalledClick);
  $("#agentList").addEventListener("click", onAgentClick);
  $("#pkgMarket").addEventListener("click", onMarketClick);
  $("#authSearch").addEventListener("input", () => renderAuthRows());
  $("#authFilters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-af]");
    if (!b) return;
    authFilter = b.dataset.af;
    document.querySelectorAll("#authFilters .af-chip").forEach((x) => x.classList.toggle("active", x === b));
    renderAuthRows();
  });
  $("#authList").addEventListener("click", onAuthListClick);
  $("#authList").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-auth-prompt-input]")) window.halo.authRespond(e.target.value.trim());
    if (e.key === "Enter" && e.target.matches("[data-auth-input]")) saveApiKey(e.target.dataset.authInput);
  });

  $("#modelSearch").addEventListener("input", (e) => renderModelList(e.target.value));

  // attachments & project
  $("#btnAttach").addEventListener("click", attachImages);
  $("#projectChip").addEventListener("click", pickProject);
  $("#projAdd").addEventListener("click", pickProject);

  // chat header
  $("#btnFocus").addEventListener("click", () => {
    const on = document.body.classList.toggle("focus-mode");
    $("#btnFocus").title = on ? "退出专注模式（恢复侧栏与工作区）" : "专注模式 · 对话全屏（隐藏侧栏与工作区）";
  });

  // composer
  const input = $("#input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.altKey) {
        const t = input.value.trim();
        if (t && S.streaming) { window.halo.followUp(t); input.value = ""; autoGrow(); }
      } else {
        send();
      }
    }
  });
  input.addEventListener("input", autoGrow);
  $("#btnSend").addEventListener("click", () => {
    // streaming + text -> steer; streaming + empty -> abort
    if (S.streaming) {
      const t = input.value.trim();
      if (t) { window.halo.steer(t); input.value = ""; autoGrow(); toast("已入队引导消息", "ok"); }
      else abort();
      return;
    }
    send();
  });

  // modals: close on backdrop / X / Esc; bare Esc aborts task
  $$(".modal").forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target === m) closeModal(m); });
    $$("[data-close]", m).forEach((b) => b.addEventListener("click", () => closeModal(m)));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = $(".modal.show");
    if (open) { closeModal(open); return; }
    if (S.streaming) abort();
  });

  // think chip button
  $("#btnThink").addEventListener("click", () => { renderThinkList(); openModal("thinkModal"); });
  $("#btnModel").addEventListener("click", () => { loadModels(); openModal("modelModal"); });
  $("#btnSkill").addEventListener("click", () => {
    $("#input").value = $("#input").value.startsWith("/") ? $("#input").value : "/" + $("#input").value;
    $("#input").focus();
  });

  // paste images
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) addImageFile(f);
  });

  // drop images
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    for (const f of files) addImageFile(f);
  });

  wireCenter();
}

/* ============================================================
   center: preview（唯一面板，文件列表已移至侧栏底部）
   ============================================================ */
function wireCenter() {
  $("#treeRefresh").addEventListener("click", () => loadTree(true));
  $("#btnNewFile").addEventListener("click", () => startCreate("file"));
  $("#btnNewDir").addEventListener("click", () => startCreate("dir"));
  $("#pvReload").addEventListener("click", () => setPreview(S.previewFile, true));
  // 预览模式切换：渲染 / 源码
  $("#pvMode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b || b.dataset.m === S.previewMode) return;
    S.previewMode = b.dataset.m;
    $$("#pvMode [data-m]").forEach((x) => x.classList.toggle("active", x === b));
    if (S.previewFile) setPreview(S.previewFile, true);
  });
  $("#pvOpen").addEventListener("click", () => { if (S.previewFile) window.halo.openPath(S.previewFile); });

  // 预览设备切换：电脑 / 平板 / 手机
  const devSize = { desktop: "100%", tablet: "768px", mobile: "390px" };
  $$(".pvdev").forEach((b) => b.addEventListener("click", () => {
    $$(".pvdev").forEach((x) => x.classList.toggle("active", x === b));
    const body = $("#pvBody");
    body.classList.remove("dev-desktop", "dev-tablet", "dev-mobile");
    body.classList.add("dev-" + b.dataset.dev);
    window.halo.previewTouch?.(b.dataset.dev !== "desktop"); // 平板/手机模式：隐藏滚动条 + 触摸式拖动
    const size = $("#pvDevSize");
    if (size) size.textContent = devSize[b.dataset.dev] || "100%";
  }));
}

/* ---- file tree ---- */
async function loadTree(force) {
  const r = await window.halo.readTree();
  const data = r?.data;
  if (!data) return;
  S.treeData = data;
  $("#wsPath").textContent = data.root;
  $("#wsPath").title = data.root;
  // auto-expand first level on first load
  if (!S.expanded.size && !force) {
    for (const n of data.tree) if (n.dir) S.expanded.add(n.path);
  }
  renderTree();
}

function scheduleTreeRefresh() {
  clearTimeout(S.treeTimer);
  S.treeTimer = setTimeout(() => loadTree(true), 1200);
}

const fmtSize = (n) => (n >= 1024 * 1024 ? (n / 1048576).toFixed(1) + "M" : n >= 1024 ? (n / 1024).toFixed(1) + "k" : n + "B");

/* 树行图标 */
const FOLDER_IC = `<svg viewBox="0 0 24 24" class="ic f-ic dir-ic"><path d="M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/></svg>`;
const FILE_IC = `<svg viewBox="0 0 24 24" class="ic f-ic"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>`;
const TRASH_IC = `<svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>`;
const EXT_COLORS = { html: "#e8622d", htm: "#e8622d", css: "#3b82c4", js: "#c4a13b", mjs: "#c4a13b", ts: "#3b76c4", py: "#3b76c4", md: "#6b7f96", json: "#8a8f3a", svg: "#9a5fc4" };
const fileIconFor = (name) => {
  const ext = name.split(".").pop().toLowerCase();
  const col = EXT_COLORS[ext];
  return col ? FILE_IC.replace("class=\"ic f-ic\"", `class=\"ic f-ic\" style=\"color:${col}\"`) : FILE_IC;
};

function findNodeByPath(nodes, p) {
  for (const n of nodes) {
    if (n.path === p) return n;
    if (n.children?.length) { const r = findNodeByPath(n.children, p); if (r) return r; }
  }
  return null;
}
function findParentDirPath(nodes, target, parent = null) {
  for (const n of nodes) {
    if (n.path === target) return parent;
    if (n.children?.length) { const r = findParentDirPath(n.children, target, n.path); if (r !== undefined) return r; }
  }
  return undefined;
}
const normSlashes = (p) => String(p || "").replace(/\\/g, "/");
const PV_EMPTY = `<div class="pv-empty"><div class="pv-ghost"><div class="pv-gscreen"><div class="pv-empty-ico">◇</div><p>agent 生成的 HTML / 图片 / Markdown 会在这里实时预览</p><p class="dim">在左下角文件列表点击文件，或让 agent 生成页面后自动打开</p></div><div class="pv-gneck"></div><div class="pv-gbase"></div></div></div>`;

function renderTree() {
  const el = $("#wsTree");
  if (!S.treeData) { el.innerHTML = `<div class="res-empty">无法读取目录</div>`; return; }
  el.innerHTML = "";
  const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  const changedSet = new Set(S.activity.map((a) => norm(a.path)));
  const addCreateRow = (container, depth, dirPath) => {
    if (!S.creating || (S.creating.parent || null) !== (dirPath || null)) return;
    const crow = document.createElement("div");
    crow.className = "trow trow-create";
    crow.style.paddingLeft = 8 + depth * 14 + "px";
    crow.innerHTML = `<span class="fic">${S.creating.kind === "dir" ? FOLDER_IC : FILE_IC}</span><input class="create-input" placeholder="${S.creating.kind === "dir" ? "文件夹名称" : "文件名称"}" />`;
    container.appendChild(crow);
    const inp = $(".create-input", crow);
    let done = false;
    const commit = async () => {
      if (done) return;
      const name = inp.value.trim();
      if (!name) { done = true; S.creating = null; renderTree(); return; }
      const r = await window.halo.createEntry({ parent: S.creating.parent, name, kind: S.creating.kind }).catch((e) => ({ error: String(e?.message || e).replace(/^Error: /, "") }));
      if (r?.error) { toast(r.error, "err"); inp.focus(); inp.select(); return; }
      done = true;
      toast("已创建 ✓", "ok");
      const created = r.data?.path;
      S.creating = null;
      await loadTree(true);
      if (created) {
        S.selectedFile = created;
        const node = findNodeByPath(S.treeData?.tree || [], created);
        if (node && !node.dir) setPreview(created);
        renderTree();
      }
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") { done = true; S.creating = null; renderTree(); }
    });
    inp.addEventListener("blur", () => setTimeout(() => { if (!done && !inp.value.trim()) { done = true; S.creating = null; renderTree(); } }, 160));
    setTimeout(() => inp.focus(), 0);
  };
  const build = (nodes, depth, container, dirPath) => {
    addCreateRow(container, depth, dirPath);
    for (const n of nodes) {
      const row = document.createElement("div");
      row.className = "trow" + (n.dir ? " dir" : " file") + (S.expanded.has(n.path) ? " open" : "") + (changedSet.has(norm(n.path)) ? " changed" : "") + (S.selectedFile === n.path ? " selected" : "");
      row.style.paddingLeft = 8 + depth * 14 + "px";
      row.innerHTML = n.dir
        ? `<span class="arrow">▶</span><span class="fic">${FOLDER_IC}</span><span class="fname">${esc(n.name)}</span><button class="trow-del" title="删除">${TRASH_IC}</button>`
        : `<span class="arrow"></span><span class="fic">${fileIconFor(n.name)}</span><span class="fname">${esc(n.name)}</span><span class="fsize">${fmtSize(n.size || 0)}</span><button class="trow-del" title="删除">${TRASH_IC}</button>`;
      row.title = n.path;
      row.addEventListener("click", () => {
        S.selectedFile = n.path;
        if (n.dir) {
          S.expanded.has(n.path) ? S.expanded.delete(n.path) : S.expanded.add(n.path);
          renderTree();
        } else {
          renderTree();
          setPreview(n.path);
        }
      });
      const del = $(".trow-del", row);
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!del.classList.contains("confirm")) {
          del.classList.add("confirm");
          del.title = "再次点击确认删除";
          clearTimeout(row._delT);
          row._delT = setTimeout(() => { del.classList.remove("confirm"); del.title = "删除"; }, 2600);
          return;
        }
        clearTimeout(row._delT);
        del.disabled = true;
        const r = await window.halo.deleteEntry(n.path).catch((err) => ({ error: String(err?.message || err).replace(/^Error: /, "") }));
        if (r?.error) { del.disabled = false; toast(r.error, "err"); return; }
        toast("已删除 ✓", "ok");
        const d = normSlashes(n.path);
        if (S.previewFile && normSlashes(S.previewFile).startsWith(d)) { S.previewFile = null; $("#pvName").textContent = "未选择文件"; $("#pvBody").innerHTML = PV_EMPTY; }
        if (S.selectedFile && normSlashes(S.selectedFile).startsWith(d)) S.selectedFile = null;
        if (S.creating?.parent && normSlashes(S.creating.parent).startsWith(d)) S.creating = null;
        await loadTree(true);
      });
      container.appendChild(row);
      if (n.dir && S.expanded.has(n.path)) {
        // 空文件夹也构建子容器，便于行内新建
        const kid = document.createElement("div");
        kid.className = "tree-kids";
        build(n.children || [], depth + 1, kid, n.path);
        container.appendChild(kid);
      }
    }
  };
  build(S.treeData.tree, 0, el, null);
  if (S.treeData.truncated) {
    const tip = document.createElement("div");
    tip.className = "res-empty";
    tip.textContent = "… 文件过多已截断";
    el.appendChild(tip);
  }
}

/* 新建文件/文件夹：行内输入，默认建在选中目录（或其父目录），否则建在根目录 */
function startCreate(kind) {
  if (!S.treeData) return toast("文件树未就绪", "err");
  const selNode = S.selectedFile ? findNodeByPath(S.treeData.tree, S.selectedFile) : null;
  let parent = null;
  if (selNode?.dir) parent = selNode.path;
  else if (selNode) parent = findParentDirPath(S.treeData.tree, selNode.path) ?? null;
  S.creating = { parent, kind };
  if (parent) S.expanded.add(parent);
  renderTree();
}

const PREVIEWABLE = ["html", "htm", "png", "jpg", "jpeg", "gif", "webp", "svg", "md", "markdown"];

function recordActivity(rec) {
  // 仅记录：文件树用 .changed 标记新改动文件
  S.activity.unshift(rec);
  if (S.activity.length > 60) S.activity.pop();
}

/* ---- preview ---- */
const previewURL = (p) => "halo-preview://local/" + encodeURI(p.replace(/\\/g, "/")).replace(/^([A-Za-z]:)/, "$1");
const currentPreviewDevice = () => {
  const c = $("#pvBody").classList;
  return c.contains("dev-tablet") ? "tablet" : c.contains("dev-mobile") ? "mobile" : "desktop";
};

async function setPreview(p, force) {
  if (!p) return;
  if (!force && S.previewFile === p) return;
  S.previewFile = p;
  const ext = p.split(".").pop().toLowerCase();
  $("#pvName").textContent = p.split(/[\\\\/]/).pop();
  const body = $("#pvBody");
  const isHtml = ext === "html" || ext === "htm";
  const modeCtl = $("#pvMode");
  if (modeCtl) modeCtl.hidden = !isHtml;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    body.innerHTML = `<img class="pv-img" src="${previewURL(p)}" />`;
  } else if (["md", "markdown"].includes(ext)) {
    body.innerHTML = `<div class="md-view">加载中…</div>`;
    const r = await window.halo.readFile(p);
    body.innerHTML = r?.data
      ? `<div class="md-view">${rich(r.data.content)}</div>`
      : `<div class="pv-empty"><p>无法读取：${esc(r?.error || "")}</p></div>`;
  } else if (["html", "htm"].includes(ext) || ext === "htm") {
    if (S.previewMode === "source") {
      // 源码模式：语法高亮 + 行号（HTML 源码可读）
      body.innerHTML = `<div class="file-view"><div class="fv-note">加载中…</div></div>`;
      const r = await window.halo.readFile(p);
      if (!r?.data) {
        body.innerHTML = `<div class="file-view"><div class="fv-note">无法读取：${esc(r?.error || "")}</div></div>`;
        return;
      }
      const content = r.data.truncated ? r.data.content.slice(0, 300000) : r.data.content;
      const lineCount = content.split("\n").length;
      const nums = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
      body.innerHTML = `<div class="file-view"><div class="fv-code"><div class="fvc-ln">${nums}</div><pre class="fvc-body">${hlFile(content, "html")}</pre></div></div>`;
    } else {
      // 手机状态栏：实时时间 + 信号/wifi/电池 + 中央打孔摄像头（仅手机模式显示，CSS 控制）
      const now = new Date();
      const timeStr = now.getHours() + ":" + String(now.getMinutes()).padStart(2, "0");
      const statusbar = `<div class="dev-statusbar"><span class="dsb-time">${timeStr}</span><span class="dsb-cam"></span><span class="dsb-icons">` +
        `<svg viewBox="0 0 16 12"><rect x="0" y="7" width="2.5" height="5" rx="0.8"/><rect x="4" y="5" width="2.5" height="7" rx="0.8"/><rect x="8" y="3" width="2.5" height="9" rx="0.8"/><rect x="12" y="1" width="2.5" height="11" rx="0.8" opacity="0.4"/></svg>` +
        `<svg viewBox="0 0 16 12"><path d="M8 10.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z"/><path d="M3.6 7.2a6.2 6.2 0 0 1 8.8 0l-1.4 1.4a4.2 4.2 0 0 0-6 0Z"/><path d="M1.2 4.8a9.6 9.6 0 0 1 13.6 0l-1.4 1.4a7.6 7.6 0 0 0-10.8 0Z"/></svg>` +
        `<svg viewBox="0 0 22 12"><rect x="0.5" y="1.5" width="18" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1"/><rect x="2.2" y="3.2" width="11" height="5.6" rx="1.2"/><rect x="19.8" y="4" width="2" height="4" rx="1"/></svg>` +
        `</span></div>`;
      body.innerHTML = `<div class="dev-shell">${statusbar}<iframe src="${previewURL(p)}"></iframe></div>`;
      window.halo.previewTouch?.(currentPreviewDevice() !== "desktop");
    }
  } else {
    // 文本文件：代码类 → 语法高亮行号视图；纯文本类 → 阅读视图
    body.innerHTML = `<div class="file-view"><div class="fv-note">加载中…</div></div>`;
    const r = await window.halo.readFile(p);
    const fv = $(".file-view", body);
    if (!r?.data) {
      fv.innerHTML = `<div class="fv-note">无法读取：${esc(r?.error || "")}（二进制或超出大小限制），可用右上角「打开」在外部查看</div>`;
      return;
    }
    const content = r.data.content;
    const lang = langOf(ext);
    if (!lang) {
      // 纯文本阅读视图：pre-wrap 自动换行，无行号干扰
      fv.innerHTML = `<div class="fv-read">${escFile(content) || "&nbsp;"}${r.data.truncated ? `<div class="fv-note">文件过长，内容已截断</div>` : ""}</div>`;
      return;
    }
    const shown = r.data.truncated ? content.slice(0, 200000) : content;
    const lineCount = shown.split("\n").length;
    const nums = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
    fv.innerHTML =
      `<div class="fv-code"><div class="fvc-ln">${nums}</div><pre class="fvc-body">${hlFile(shown, lang)}</pre></div>` +
      (r.data.truncated || lineCount > 2000 ? `<div class="fv-note">文件过长，仅显示部分内容${r.data.truncated ? "（且已截断）" : ""}</div>` : "");
  }
}

function renderThinkList() {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const cur = S.state?.thinkingLevel || "off";
  $("#thinkList").innerHTML = "";
  for (const lv of levels) {
    const b = document.createElement("button");
    b.className = "think-item" + (lv === cur ? " current" : "");
    b.innerHTML = `<span>${THINK_LABELS[lv]}</span><span class="ti-desc">${THINK_DESC[lv]}</span>`;
    b.addEventListener("click", async () => {
      const r = await window.halo.setThinking(lv);
      if (r?.ok) { applyState(r.data); closeModal(); }
    });
    $("#thinkList").appendChild(b);
  }
}

/* ---- attachments ---- */
/* 图片 MIME 三重兑底：dataURL 头 → file.type → base64 魔数；永不让 undefined 出门 */
const IMAGE_SNIFF = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
];
function sniffImageMime(b64 = "") {
  for (const [p, m] of IMAGE_SNIFF) if (b64.startsWith(p)) return m;
  return "";
}
const normImageMime = (m) => (m === "image/jpg" ? "image/jpeg" : m);

async function attachImages() {
  const r = await window.halo.pickImages();
  const imgs = (r?.data || []).map((i) => ({
    ...i,
    mediaType: normImageMime(i.mediaType) || sniffImageMime(i.data) || "image/png",
  }));
  S.images.push(...imgs);
  renderAttachments();
}

function addImageFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result);
    const data = url.split(",")[1] || "";
    const fromUrl = (url.match(/^data:([^;,]+)/) || [])[1] || "";
    const mediaType = normImageMime(fromUrl || file.type || sniffImageMime(data));
    if (!mediaType.startsWith("image/")) return toast(`不支持的图片：${trunc(file.name, 24)}`, "err");
    attachPrepared({ name: file.name, mediaType, data });
  };
  reader.readAsDataURL(file);
}

/* 入队前准备：超大图自动压缩（限制最大边长 + 转 JPEG），避免多图历史撑爆请求体 */
async function attachPrepared(img) {
  try {
    const bytes = Math.floor((img.data.length * 3) / 4);
    if (bytes > 400 * 1024) {
      const small = await downscaleImage(img.data, img.mediaType, 1600, 0.85);
      if (small && small.data.length < img.data.length) {
        S.images.push({ name: img.name.replace(/\.png$/i, ".jpg"), mediaType: small.mediaType, data: small.data });
        renderAttachments();
        toast("大图已自动压缩", "ok");
        return;
      }
    }
  } catch {}
  S.images.push(img);
  renderAttachments();
}

function downscaleImage(b64, srcMime, maxSide, quality) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(im.width, im.height));
      if (scale >= 1) return resolve(null);
      const c = document.createElement("canvas");
      c.width = Math.round(im.width * scale);
      c.height = Math.round(im.height * scale);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      resolve({ mediaType: "image/jpeg", data: c.toDataURL("image/jpeg", quality).split(",")[1] });
    };
    im.onerror = () => resolve(null);
    im.src = `data:${srcMime};base64,${b64}`;
  });
}

function renderAttachments() {
  const row = $("#attachRow");
  row.hidden = S.images.length === 0;
  row.innerHTML = "";
  S.images.forEach((img, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.innerHTML = `<img src="data:${img.mediaType};base64,${img.data}" /><span>${esc(trunc(img.name, 18))}</span><button title="移除">×</button>`;
    $("button", chip).addEventListener("click", () => { S.images.splice(i, 1); renderAttachments(); });
    row.appendChild(chip);
  });
}

/* ---- project (A9: no-op when unchanged) ---- */
async function applyProjectReset() {
  clearChat();
  S.previewFile = null;
  $("#pvBody").innerHTML = PV_EMPTY;
  $("#pvName").textContent = "未选择文件";
  S.expanded.clear();
  S.creating = null;
}

async function pickProject() {
  if (S.streaming) return toast("任务进行中，无法切换项目", "err");
  const prev = S.state?.cwd || ""; // 必须在对话框之前保存：主进程选完目录会立即切换并推送状态
  const r = await window.halo.pickProject(prev);
  const dir = r?.data;
  if (!dir) return;
  // 注意：此刻 S.state.cwd 已被主进程更新为新目录，不能再拿它做比较，
  // 否则守卫恒真、switchProjectViaAdd 永不执行，左侧列表永远不刷新
  if (normPath(dir) === normPath(prev)) return; // 选的是当前项目 → 无操作
  // projectAdd 内部去重：已在列表只切换，新目录加入列表后切换
  await switchProjectViaAdd(dir);
}
async function switchProjectViaAdd(dir) {
  toast(`正在添加项目 · ${String(dir).split(/[\\/]/).pop()}…`, "");
  const box = $("#projList");
  if (box) box.style.opacity = "0.5";
  const r = await window.halo.projectAdd(dir);
  if (box) box.style.opacity = "";
  if (!r?.ok) return toast(`添加失败：${r?.error || ""}`, "err");
  applyProjectReset();
  await Promise.all([loadTree(true), loadSessions(), loadResources()]);
  loadProjects();
  await restoreHistory();
  saveWorkspace();
  toast(`已添加项目 · ${String(dir).split(/[\\/]/).pop()}`, "ok");
}

/* ---- 项目：一个项目 = 一个文件夹，各自记住上一个对话 ---- */
async function loadProjects() {
  const box = $("#projList");
  if (!box) return;
  const r = await window.halo.projectsList();
  const list = r?.data || [];
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="res-empty">还没有项目，点上方“＋ 添加”</div>`;
    return;
  }
  for (const p of list) {
    const row = document.createElement("div");
    row.className = "proj-row" + (p.active ? " active" : "");
    row.title = p.cwd;
    row.innerHTML = `
      <span class="pj-ic">▸</span>
      <span class="pj-name">${esc(p.name)}</span>
      ${p.active ? `<span class="pj-cur">当前</span>` : ""}
      ${p.active ? "" : `<button class="pj-del" title="从列表移除（不删除文件夹）">×</button>`}`;
    row.addEventListener("click", () => {
      if (p.active) return;
      switchProject(p.cwd);
    });
    const del = row.querySelector(".pj-del");
    if (del) del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.halo.projectRemove(p.cwd);
      loadProjects();
      toast(`已从列表移除 ${p.name}`, "ok");
    });
    box.appendChild(row);
  }
}
async function switchProject(cwd) {
  if (S.streaming) return toast("任务进行中，无法切换项目", "err");
  toast(`正在切换项目 · ${String(cwd).split(/[\\/]/).pop()}…`, "");
  const box = $("#projList");
  if (box) box.style.opacity = "0.5";
  const r = await window.halo.projectSwitch(cwd);
  if (box) box.style.opacity = "";
  if (!r?.ok) return toast(`切换失败：${r?.error || ""}`, "err");
  applyProjectReset();
  await Promise.all([loadTree(true), loadSessions(), loadResources()]);
  loadProjects();
  await restoreHistory();
  saveWorkspace();
  toast(`已切换项目 · ${String(cwd).split(/[\\/]/).pop()}`, "ok");
}

/* ============================================================
   modals / toast / misc
   ============================================================ */
function openModal(id) {
  const m = document.getElementById(id);
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add("show"));
  if (id === "modelModal") { $("#modelSearch").value = ""; loadModels(); }
}
function closeModal(m) {
  const el = m || $(".modal.show");
  if (!el) return;
  el.classList.remove("show");
  setTimeout(() => (el.hidden = true), 280);
}

function toast(text, kind = "") {
  // 重复消息过滤：屏幕上已有相同文案且未消失的 toast 时不再追加
  if ($$("#toasts .toast:not(.out)").some((t) => t.dataset.text === text)) return;
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.dataset.text = text;
  t.innerHTML = `<span class="t-dot"></span><span>${esc(text)}</span>`;
  $("#toasts").appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 420);
  }, 2600);
}

function autoGrow() {
  const input = $("#input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

function scrollDown(force = false) {
  const m = $("#messages");
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  // "instant" bypasses the CSS smooth behavior: per-delta smooth scrolls keep
  // interrupting each other and permanently fall behind fast streaming output
  if (force || nearBottom) m.scrollTo({ top: m.scrollHeight, behavior: "instant" });
}

/* ============================================================
   auth / login modal（与 pi CLI 共享 ~/.pi/agent/auth.json）
   ============================================================ */
let authRows = [];
let authFilter = "all"; // all | oauth | key
const authPending = new Map(); // providerId -> pending api key (answer secret prompts)

async function openAuthModal() {
  authFilter = "all";
  document.querySelectorAll("#authFilters .af-chip").forEach((x) =>
    x.classList.toggle("active", x.dataset.af === "all"));
  $("#authSearch").value = "";
  openModal("authModal");
  await renderAuthList();
}

async function renderAuthList() {
  const list = $("#authList");
  list.innerHTML = `<div class="model-empty">加载中…</div>`;
  try {
    authRows = (await window.halo.authProviders())?.data || [];
  } catch (e) {
    list.innerHTML = `<div class="model-empty">加载失败：${esc(String(e?.message || e))}</div>`;
    return;
  }
  renderAuthRows();
}

function renderAuthRows() {
  const list = $("#authList");
  const f = ($("#authSearch").value || "").trim().toLowerCase();
  const rows = authRows
    .filter((p) => authFilter === "all" || (authFilter === "oauth" ? p.canOAuth : p.canApiKey))
    .filter((p) => !f || (p.name + p.id).toLowerCase().includes(f));
  if (!rows.length) { list.innerHTML = `<div class="model-empty">没有匹配的供应商</div>`; return; }
  list.innerHTML = rows.map((p) => {
    const status = p.configured
      ? `<span class="chat-badge auth-ok">✓ 已登录</span>`
      : `<span class="chat-badge">未登录</span>`;
    const actions = [
      p.canOAuth ? `<button class="mini-btn" data-auth-oauth="${esc(p.id)}">${p.subscription ? "订阅登录" : "OAuth 登录"}</button>` : "",
      p.canApiKey ? `<button class="mini-btn" data-auth-key="${esc(p.id)}">API Key</button>` : "",
      p.configured ? `<button class="mini-btn" data-auth-logout="${esc(p.id)}">登出</button>` : "",
    ].filter(Boolean).join("");
    return `<div class="auth-row" data-auth-row="${esc(p.id)}">
      <div class="auth-name"><span>${esc(p.name)}</span>${status}<small>${esc(p.id)}</small></div>
      <div class="auth-actions">${actions}</div>
      <div class="auth-progress" data-auth-progress="${esc(p.id)}" hidden></div>
      <div class="auth-keyrow" data-auth-keyrow="${esc(p.id)}" hidden>
        <input type="password" placeholder="粘贴 API Key…" data-auth-input="${esc(p.id)}" />
        <button class="mini-btn" data-auth-save="${esc(p.id)}">保存</button>
      </div>
    </div>`;
  }).join("");
}

function onAuthListClick(e) {
  const sel = e.target.closest("[data-auth-select]");
  if (sel) { window.halo.authRespond(sel.dataset.authSelect); return; }
  const sub = e.target.closest("[data-auth-prompt-submit]");
  if (sub) {
    const inp = $("[data-auth-prompt-input]", sub.closest(".auth-progress"));
    window.halo.authRespond(inp?.value.trim() || "");
    return;
  }
  if (e.target.closest("[data-auth-prompt-cancel]")) { window.halo.authCancel(); return; }
  const oauth = e.target.closest("[data-auth-oauth]");
  if (oauth) { startAuthLogin(oauth.dataset.authOauth, "oauth"); return; }
  const key = e.target.closest("[data-auth-key]");
  if (key) {
    const row = $(`[data-auth-keyrow="${CSS.escape(key.dataset.authKey)}"]`);
    if (row) { row.hidden = !row.hidden; if (!row.hidden) $("[data-auth-input]", row)?.focus(); }
    return;
  }
  const save = e.target.closest("[data-auth-save]");
  if (save) { saveApiKey(save.dataset.authSave); return; }
  const out = e.target.closest("[data-auth-logout]");
  if (out) doLogout(out.dataset.authLogout);
}

async function startAuthLogin(providerId, type) {
  const prog = $(`[data-auth-progress="${CSS.escape(providerId)}"]`);
  if (prog) { prog.hidden = false; prog.dataset.phase = "start"; prog.textContent = "正在启动登录流程…"; }
  const t0 = Date.now();
  const tick = setInterval(() => {
    const p2 = $(`[data-auth-progress="${CSS.escape(providerId)}"]`);
    if (!p2 || p2.hidden || p2.dataset.phase !== "start") { clearInterval(tick); return; }
    p2.textContent = `登录流程进行中… ${Math.floor((Date.now() - t0) / 1000)}s（若长时间无变化，请查看启动终端的 [auth] 日志）`;
  }, 1000);
  try {
    await window.halo.authLogin(providerId, type);
  } catch (e) {
    /* error already toasted via auth_event; refresh statuses */
    renderAuthRows();
    updateAuthSummary();
  } finally {
    clearInterval(tick);
  }
}

async function saveApiKey(providerId) {
  const inp = $(`[data-auth-input="${CSS.escape(providerId)}"]`);
  const value = inp?.value.trim() || "";
  if (!value) return toast("请先粘贴 API Key", "err");
  authPending.set(providerId, value);
  await window.halo.authLogin(providerId, "api_key").catch(() => {});
  authPending.delete(providerId);
  await renderAuthList();
  updateAuthSummary();
}

async function doLogout(providerId) {
  try {
    await window.halo.authLogout(providerId);
    toast("已登出", "ok");
  } catch (e) {
    toast(`登出失败：${e?.message || e}`, "err");
  }
  await renderAuthList(); // 重新拉取登录状态，避免徽章滞留
  updateAuthSummary();
  await loadModels();
  await ensureModelAvailable();
}

/* 登出/登录后保持当前对话模型可用：不可用则自动切换，全部不可用则提示登录 */
async function ensureModelAvailable() {
  const cur = S.state?.model;
  const ok = cur && S.models.some((m) => m.provider === cur.provider && m.id === cur.id);
  if (ok) return;
  if (!S.models.length) { toast("所有模型均已登出，请先在登录配置里登录账号", "err"); return; }
  const m = S.models[0];
  const r = await window.halo.setModel(m.provider, m.id);
  if (r?.ok) applyState(r.data);
  if (cur) toast(`当前模型已不可用，已自动切换到 ${m.name}`, "ok");
}

async function onAuthEvent(ev) {
  console.debug("[auth] renderer event:", ev.phase, ev.providerId);
  const prog = $(`[data-auth-progress="${CSS.escape(ev.providerId)}"]`);
  const show = (html) => { if (prog) { prog.hidden = false; prog.dataset.phase = "event"; prog.innerHTML = html; } };
  if (ev.phase === "notify") {
    const n = ev.event || {};
    if (n.type === "auth_url") {
      show(`浏览器已打开，请完成授权…<br><a href="${esc(n.url)}" target="_blank">${esc(n.url)}</a>`);
      try { window.open(n.url, "_blank"); } catch {}
    } else if (n.type === "device_code") {
      show(`设备码：<b>${esc(n.userCode)}</b> · 正在打开 <a href="${esc(n.verificationUri)}" target="_blank">${esc(n.verificationUri)}</a>`);
      try { window.open(n.verificationUri, "_blank"); } catch {}
    } else if (n.type === "info" || n.type === "progress") {
      show(esc(n.message || "…"));
    }
  } else if (ev.phase === "prompt") {
    const p = ev.prompt || {};
    const inputHtml = `<span class="auth-inline-input"><input data-auth-prompt-input placeholder="${esc(p.placeholder || "")}" /></span> <button class="mini-btn" data-auth-prompt-submit>提交</button> <button class="mini-btn" data-auth-prompt-cancel>取消</button>`;
    if (p.type === "secret" || p.type === "text") {
      const pending = authPending.get(ev.providerId);
      if (pending !== undefined) { window.halo.authRespond(pending); show("已提交，正在验证…"); return; }
      show(`${esc(p.message || "请输入：")}<br>${inputHtml}`);
    } else if (p.type === "manual_code") {
      show(`${esc(p.message || "请在浏览器完成登录后，粘贴授权码或回调 URL：")}<br>${inputHtml}`);
    } else if (p.type === "select") {
      show(`${esc(p.message || "请选择：")}<br>` + (p.options || []).map((o) => `<button class="mini-btn" data-auth-select="${esc(o.id)}">${esc(o.label)}</button>`).join(" "));
    }
  } else if (ev.phase === "done") {
    toast(`登录成功 ✓（${ev.providerId}）`, "ok");
    if (prog) prog.hidden = true;
    await renderAuthList();
    updateAuthSummary();
    await loadModels();
    await ensureModelAvailable();
  } else if (ev.phase === "error") {
    toast(`登录失败：${ev.error}`, "err");
    if (prog) prog.hidden = true;
  }
}

/* 登录状态仅用于 authBtn 的 tooltip（右侧聊天框已显示模型信息） */
async function updateAuthSummary() {
  try {
    const rows = ((await window.halo.authProviders())?.data) || [];
    const n = rows.filter((r) => r.configured).length;
    $("#authBtn").title = n ? `登录配置 · 已登录 ${n} 个供应商` : "登录配置";
  } catch {}
}

/* ============================================================
   settings · 插件与技能（pi 包生态：搜索 / 安装 / 卸载 / 启用停用）
   ============================================================ */
const PKG_TYPE_CN = { extension: "扩展", skill: "技能", theme: "主题", prompt: "提示词", package: "综合包" };
const relTime = (iso) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return Math.max(1, Math.floor(d / 60)) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  if (d < 86400 * 30) return Math.floor(d / 86400) + " 天前";
  if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + " 个月前";
  return Math.floor(d / 86400 / 365) + " 年前";
};
function openSettings() {
  openModal("settingsModal");
  loadAgents();
  loadDefaultModels();
  if (!S.pkgLoaded) {
    S.pkgLoaded = true;
    loadInstalled().then(() => loadMarket(true));
  } else {
    loadInstalled();
  }
}
async function loadDefaultModels() {
  const list = $("#defModelList");
  if (!list) return;
  list.innerHTML = `<div class="pkg-empty">读取模型列表…</div>`;
  const [mr, dr] = await Promise.all([window.halo.listModels(), window.halo.defaultModelGet()]);
  const models = (mr?.data || []).filter((m) => !m.error);
  const cur = dr?.data || "";
  const nameEl = $("#defModelName");
  if (nameEl) nameEl.textContent = cur ? cur.split("/").pop() : "跟随上次使用";
  if (!models.length) {
    list.innerHTML = `<div class="pkg-empty">尚未发现可用模型，请先通过 pi 登录</div>`;
    return;
  }
  const groups = new Map();
  for (const m of models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  list.innerHTML = "";
  for (const [prov, ms] of groups) {
    const g = document.createElement("div");
    g.className = "model-group-label";
    g.textContent = prov;
    list.appendChild(g);
    for (const m of ms) {
      const key = m.provider + "/" + m.id;
      const isCur = cur === key;
      const row = document.createElement("div");
      row.className = "agent-row" + (isCur ? " on" : "");
      row.dataset.key = key;
      row.innerHTML = `
        <div class="pkg-main">
          <span class="pkg-name">${esc(m.name)}</span>
          <span class="agent-desc">${esc(m.provider)}/${esc(m.id)}${m.reasoning ? " · reasoning" : ""} · ${fmtTokens(m.contextWindow)}</span>
        </div>
        <div class="pkg-ops"><span class="agent-cur">默认</span></div>`;
      row.addEventListener("click", async () => {
        const r = await window.halo.defaultModelSet(key);
        if (r?.ok) {
          list.querySelectorAll(".agent-row").forEach((x) => x.classList.toggle("on", x === row));
          if (nameEl) nameEl.textContent = m.id;
          toast(`默认模型已设置：${m.name}`, "ok");
        } else toast(`设置失败：${r?.error || ""}`, "err");
      });
      list.appendChild(row);
    }
  }
}
async function loadAgents() {
  const box = $("#agentList");
  if (!box) return;
  box.innerHTML = `<div class="pkg-empty">读取中…</div>`;
  const [lr, dr] = await Promise.all([window.halo.agentList(), window.halo.agentDefaultGet()]);
  const list = (lr?.data || []);
  const cur = dr?.data || "";
  if (!list.length) {
    box.innerHTML = `<div class="pkg-empty">未发现智能体定义（用户级 ~/.pi/agent/agents 或项目 .pi/agents 下没有 *.md）</div>`;
    return;
  }
  box.innerHTML = [`
    <div class="agent-row${cur === "" ? " on" : ""}" data-name="">
      <div class="pkg-main"><span class="pkg-name">默认（pi 编程助手）</span></div>
      <div class="pkg-ops"><span class="agent-cur">使用中</span></div>
    </div>`]
    .concat(list.map((a) => `
    <div class="agent-row${cur === a.name ? " on" : ""}" data-name="${esc(a.name)}" title="${esc(a.path)}">
      <div class="pkg-main">
        <span class="pkg-name">${esc(a.name)}</span>
        ${a.desc ? `<span class="agent-desc">${esc(a.desc)}</span>` : ""}
        <span class="pkg-kind">${a.scope === "user" ? "用户级" : a.scope === "project" ? "项目级" : "内置"}</span>
      </div>
      <div class="pkg-ops"><span class="agent-cur">使用中</span></div>
    </div>`)).join("");
}
async function onAgentClick(e) {
  const row = e.target.closest(".agent-row");
  if (!row) return;
  const name = row.dataset.name || "";
  const r = await window.halo.agentDefaultSet(name);
  if (r?.ok) {
    document.querySelectorAll("#agentList .agent-row").forEach((x) => x.classList.toggle("on", x === row));
    toast(name ? `默认智能体已切换：${name}（下一条消息生效）` : "已恢复默认 pi 编程助手", "ok");
  } else {
    toast(`设置失败：${r?.error || ""}`, "err");
  }
}
async function loadInstalled() {
  const box = $("#pkgInstalled");
  box.innerHTML = `<div class="pkg-empty">读取中…</div>`;
  const r = await window.halo.pkgInstalled();
  const list = r?.data || [];
  S.pkgInstalledList = list;
  $("#pkgInstalledCount").textContent = list.length ? list.length + " 个" : "";
  const upd = list.filter((p) => p.update).length;
  const updBtn = $("#pkgUpdateAll");
  updBtn.hidden = !upd;
  updBtn.textContent = `一键更新 (${upd})`;
  updBtn.disabled = false;
  if (!list.length) {
    box.innerHTML = `<div class="pkg-empty">尚未安装任何包</div>`;
    return;
  }
  box.innerHTML = list.map((p, i) => {
    const name = esc(p.raw.replace(/^npm:/, ""));
    const ver = p.update ? `<span class="pkg-ver upd" title="${esc(p.version)} → ${esc(p.latest)}">${esc(p.version)} → ${esc(p.latest)}</span>` : p.version ? `<span class="pkg-ver">v${esc(p.version)}</span>` : "";
    return `<div class="pkg-row${p.disabled ? " off" : ""}" data-i="${i}">
      <div class="pkg-main">
        <span class="pkg-name">${name}</span>
        ${ver}
        <span class="pkg-kind">${p.kind === "npm" ? "npm" : p.kind === "git" ? "git" : "本地"}</span>
        ${p.disabled ? `<span class="pkg-off-badge">已停用</span>` : ""}
      </div>
      <div class="pkg-ops">
        <button class="ext-switch${p.disabled ? "" : " on"}" data-act="toggle" title="${p.disabled ? "启用" : "停用"}"></button>
        ${p.update ? `<button class="mini-btn accent" data-act="update">更新</button>` : ""}
        <button class="mini-btn danger" data-act="remove">卸载</button>
      </div>
    </div>`;
  }).join("");
}
async function updateAllPkgs() {
  const btn = $("#pkgUpdateAll");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "更新中…";
  try {
    const r = await window.halo.pkgUpdateAll();
    const d = r?.data || {};
    if (d.total) {
      showPending();
      if (d.failed?.length) toast(`已更新 ${d.updated.length} 个，${d.failed.length} 个失败`, "err");
      else toast(`已更新 ${d.updated.length} 个包（新会话生效）`, "ok");
    } else {
      toast("所有包均已是最新", "ok");
    }
  } catch (e) {
    toast(`一键更新失败：${e?.message || e}`, "err");
  }
  await loadInstalled();
  if (S.pkgLoaded) loadMarket(true);
}
async function loadMarket(reset) {
  if (reset) {
    S.pkgFrom = 0;
    $("#pkgMarket").innerHTML = `<div class="pkg-empty">加载中…</div>`;
    S.pkgItems = [];
  }
  const size = 20;
  const r = await window.halo.pkgSearch({ query: S.pkgQuery || "", from: S.pkgFrom || 0, size });
  const box = $("#pkgMarket");
  if (!r?.ok) {
    box.innerHTML = `<div class="pkg-empty">加载失败：${esc(r?.error || "")}</div>`;
    return;
  }
  const items = r.data?.items || [];
  const all = reset ? items : (S.pkgItems || []).concat(items);
  S.pkgItems = all;
  S.pkgTotal = r.data?.total || 0;
  $("#pkgTotal").textContent = all.length ? `${all.length} / ${S.pkgTotal}` : "";
  const installedNorm = new Set((S.pkgInstalledList || []).map((p) => normPkgSource(p.raw)));
  const notInstalled = all.filter((p) => !installedNorm.has(normPkgSource("npm:" + p.name)));
  const filtered = S.pkgType && S.pkgType !== "all"
    ? notInstalled.filter((p) => p.types?.includes(S.pkgType))
    : notInstalled;
  if (!filtered.length) {
    // 当前页全是已安装的包：还有下一页就自动续拉
    if (all.length < S.pkgTotal) return loadMarket(false);
    box.innerHTML = `<div class="pkg-empty">没有更多未安装的包</div>`;
    $("#pkgMore").hidden = true;
    return;
  }
  box.innerHTML = filtered.map((p, i) => {
    const installed = installedNorm.has(normPkgSource("npm:" + p.name));
    const badges = (p.types || []).map((t) => `<span class="pkg-type t-${t}">${PKG_TYPE_CN[t] || t}</span>`).join("");
    const repo = p.repo ? `<a class="pkg-repo" href="${esc(p.repo)}" target="_blank" rel="noopener" title="源码仓库">仓库</a>` : "";
    return `<div class="pkg-card" data-i="${i}">
      <div class="pkg-c-head">
        <span class="pkg-name">${esc(p.name.replace(/^npm:/, ""))}</span>
        ${badges}
      </div>
      <div class="pkg-desc">${esc(trunc(p.desc || "（无描述）", 120))}</div>
      <div class="pkg-meta">
        <span>v${esc(p.version || "?")}</span>
        <span>${relTime(p.date)}</span>
        ${p.author ? `<span>@${esc(p.author)}</span>` : ""}
        ${repo}
        <span class="pkg-spacer"></span>
        ${installed
          ? `<span class="pkg-in-mark">✓ 已安装</span>`
          : `<button class="mini-btn accent" data-act="install" data-name="${esc(p.name)}">安装</button>`}
      </div>
    </div>`;
  }).join("");
  S.pkgFrom = (S.pkgFrom || 0) + size;
  $("#pkgMore").hidden = all.length >= S.pkgTotal;
}
const normPkgSource = (s) => {
  let v = String(s || "").trim();
  if (v.startsWith("npm:")) {
    v = v.replace(/(npm:[^@]+)@[\w.+-]+$/, "$1");
  }
  return v.toLowerCase();
};
function showPending() { $("#pkgPendingBar").hidden = false; }
async function onInstalledClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const row = btn.closest(".pkg-row");
  const p = S.pkgInstalledList?.[+row.dataset.i];
  if (!p) return;
  const act = btn.dataset.act;
  if (act === "toggle") {
    btn.disabled = true;
    // on 参数 = 目标启用态：当前停用中 → on=true 启用；当前启用中 → on=false 停用
    const r = await window.halo.pkgToggle(p.raw, p.disabled);
    if (r?.ok) {
      p.disabled = !p.disabled;
      showPending();
      // 就地更新该行，不重载列表（避免闪烁）
      row.classList.toggle("off", p.disabled);
      btn.classList.toggle("on", !p.disabled);
      btn.title = p.disabled ? "启用" : "停用";
      const main = row.querySelector(".pkg-main");
      let badge = main.querySelector(".pkg-off-badge");
      if (p.disabled && !badge) {
        badge = document.createElement("span");
        badge.className = "pkg-off-badge";
        badge.textContent = "已停用";
        main.appendChild(badge);
      } else if (!p.disabled && badge) badge.remove();
      toast(p.disabled ? "已停用（新会话生效）" : "已启用（新会话生效）", "ok");
    } else {
      toast(`操作失败：${r?.error || ""}`, "err");
    }
    btn.disabled = false;
  } else if (act === "remove") {
    if (!row.classList.contains("confirm")) {
      row.classList.add("confirm");
      btn.textContent = "确认卸载？";
      setTimeout(() => { row.classList.remove("confirm"); btn.textContent = "卸载"; }, 2600);
      return;
    }
    btn.disabled = true;
    btn.textContent = "卸载中…";
    const r = await window.halo.pkgRemove(p.raw);
    if (r?.ok) {
      toast("已卸载（新会话生效）", "ok");
      showPending();
      // 就地移除该行，不重载列表
      const idx = S.pkgInstalledList.indexOf(p);
      if (idx >= 0) S.pkgInstalledList.splice(idx, 1);
      row.remove();
      [...$("#pkgInstalled").querySelectorAll(".pkg-row")].forEach((el, i) => { el.dataset.i = i; });
      const list = S.pkgInstalledList;
      $("#pkgInstalledCount").textContent = list.length ? list.length + " 个" : "";
      if (!list.length) $("#pkgInstalled").innerHTML = `<div class="pkg-empty">尚未安装任何包</div>`;
      if (S.pkgLoaded) loadMarket(true);
    } else {
      btn.disabled = false;
      btn.textContent = "卸载";
      toast(`卸载失败：${r?.error || r?.output || ""}`, "err");
    }
  } else if (act === "update") {
    btn.disabled = true;
    btn.textContent = "更新中…";
    const r = await window.halo.pkgUpdate(p.raw);
    btn.disabled = false;
    btn.textContent = "更新";
    toast(r?.ok ? "已是最新 / 更新完成" : `更新失败：${r?.error || r?.output || ""}`, r?.ok ? "ok" : "err");
    if (r?.ok) showPending();
  }
}
async function onMarketClick(e) {
  const btn = e.target.closest('[data-act="install"]');
  if (!btn) return;
  const name = btn.dataset.name;
  const source = "npm:" + name;
  btn.disabled = true;
  btn.textContent = "安装中…";
  const r = await window.halo.pkgInstall(source);
  if (r?.ok) {
    toast(`已安装 ${name}（新会话生效）`, "ok");
    showPending();
    await loadInstalled();
    loadMarket(true);
  } else {
    btn.disabled = false;
    btn.textContent = "安装";
    toast(`安装失败：${r?.error || r?.output || ""}`, "err");
  }
}
async function applyPkgChanges() {
  const btn = $("#pkgApply");
  if (S.streaming) return toast("任务进行中，无法重载", "err");
  btn.disabled = true;
  btn.textContent = "重载中…";
  const r = await window.halo.pkgReload();
  btn.disabled = false;
  btn.textContent = "立即重载";
  if (r?.ok) {
    $("#pkgPendingBar").hidden = true;
    clearChat();
    await refreshAll();
    toast("插件配置已生效，已开启新会话", "ok");
  } else {
    toast(`重载失败：${r?.error || ""}`, "err");
  }
}

/* ============================================================
   tiny rich text (safe markdown-lite)
   ============================================================ */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- 轻量语法高亮（文件预览代码视图） ---- */
const escFile = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const HL_KW = {
  js: "const let var function return if else for while do switch case break continue new class extends import export from default try catch finally throw typeof instanceof in of this null undefined true false async await yield static get set delete void super",
  py: "def class import from return if elif else for while in not and or try except finally with as lambda None True False pass break continue raise global nonlocal yield async await assert del is",
  sh: "if then else elif fi for while do done case esac function echo export local return set source alias until select time",
  css: "important media supports keyframes root",
};
const HL_LANG = {
  py: "py",
  js: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", jsx: "js", java: "js", c: "js", cpp: "js", h: "js", hpp: "js", go: "js", rs: "js", php: "js", rb: "js", swift: "js", kt: "js", cs: "js",
  css: "css", json: "json",
  html: "html", htm: "html", xml: "html", vue: "html", svelte: "html", svg: "html",
  sh: "sh", bash: "sh", bat: "sh", ps1: "sh", yaml: "sh", yml: "sh", toml: "sh", ini: "sh", conf: "sh", env: "sh",
};
const langOf = (ext) => HL_LANG[ext] || null;
const HL_RE = {
  js: /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|async|await|yield|static|get|set|delete|void|super)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()/g,
  py: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(def|class|import|from|return|if|elif|else|for|while|in|not|and|or|try|except|finally|with|as|lambda|None|True|False|pass|break|continue|raise|global|nonlocal|yield|async|await|assert|del|is)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_][\w]*)(?=\s*\()/g,
  sh: /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|echo|export|local|return|set|source|alias|until|select|time)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_][\w-]*)(?=\s*\()/g,
  css: /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|([\w-]+)(?=\s*:)|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr)?\b)|(@[\w-]+|[.#][\w-]+)/g,
  json: /("(?:[^"\\\n]|\\.)*")(?=\s*:)|("(?:[^"\\\n]|\\.)*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
  html: /(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?[\w-]+)|([\w-]+)(?==)|("(?:[^"\\\n]|\\.)*")|(&gt;)/g,
};
const HL_CLS = ["c-com", "c-str", "c-kw", "c-num", "c-fn"];
function hlFile(code, lang) {
  const s = escFile(code);
  const re = HL_RE[lang];
  if (!re) return s;
  let out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out += s.slice(last, m.index);
    const gi = m.slice(1).findIndex((g) => g !== undefined);
    out += `<span class="${HL_CLS[gi] || "c-fn"}">${m[0]}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += s.slice(last);
  return out;
}

/* 完整 markdown 渲染（聊天回复 + md 文件预览共用）：标题/表格/列表/引用/任务/删除线/链接/图片/代码 */
const mdUrl = (u, mdPath) => {
  u = String(u || "").trim();
  if (/^(https?:|mailto:|halo-preview:|data:image\/)/i.test(u)) return u.replace(/"/g, "%22");
  if (mdPath && !/^[a-z]+:/i.test(u)) {
    const dir = mdPath.replace(/[\\/][^\\/]*$/, "");
    const parts = dir.split(/[\\/]/);
    for (const seg of u.replace(/^\.\//, "").split(/[\\/]/)) {
      if (seg === "..") parts.pop();
      else if (seg !== "." && seg) parts.push(seg);
    }
    return previewURL(parts.join("/"));
  }
  return null;
};
function mdInline(s, mdPath) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(`<code>${c}</code>`); return `\u0000C${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    const u = mdUrl(url, mdPath);
    return u ? `<img src="${u}" alt="${alt.replace(/"/g, "&quot;")}" loading="lazy">` : _;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const u = mdUrl(url, mdPath);
    return u ? `<a href="${u}" target="_blank" rel="noopener">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, k) => codes[+k]);
  return s;
}
const mdSplitRow = (line) => {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
};
const LI_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
function mdList(lines, i, mdPath) {
  const ordered = /\d/.test(lines[i].match(LI_RE)[2][0]);
  const base = lines[i].match(LI_RE)[1].length;
  let out = ordered ? "<ol>" : "<ul>";
  while (i < lines.length) {
    const m = lines[i].match(LI_RE);
    if (m && m[1].length === base) {
      let text = m[3];
      const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
      out += "<li>" + (task ? `<input type="checkbox" disabled ${task[1] !== " " ? "checked" : ""}> ` + mdInline(task[2], mdPath) : mdInline(text, mdPath));
      i++;
      if (i < lines.length && LI_RE.test(lines[i]) && lines[i].match(LI_RE)[1].length > base) {
        const r = mdList(lines, i, mdPath);
        out += r.html; i = r.next;
      }
      out += "</li>";
    } else if (!lines[i].trim() && i + 1 < lines.length && LI_RE.test(lines[i + 1])) {
      i++;
    } else break;
  }
  return { html: out + (ordered ? "</ol>" : "</ul>"), next: i };
}
function mdBlocks(lines, mdPath) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m = line.match(/^\s*(`{3,}|~{3,})\s*(\w*)\s*$/);
    if (m) {
      const buf = []; i++;
      while (i < lines.length && !new RegExp("^\\s*" + m[1]).test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${buf.join("\n").replace(/\n$/, "")}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) { const h = m[1].length; out.push(`<h${h}>${mdInline(m[2], mdPath)}</h${h}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const aligns = mdSplitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      const head = mdSplitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(mdSplitRow(lines[i])); i++; }
      const th = head.map((c, k) => `<th style="text-align:${aligns[k] || "left"}">${mdInline(c, mdPath)}</th>`).join("");
      const tb = rows.map((r) => "<tr>" + head.map((_, k) => `<td style="text-align:${aligns[k] || "left"}">${mdInline(r[k] ?? "", mdPath)}</td>`).join("") + "</tr>").join("");
      out.push(`<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }
    if (/^\s*&gt;/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) { buf.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
      out.push(`<blockquote>${mdBlocks(buf, mdPath)}</blockquote>`);
      continue;
    }
    if (LI_RE.test(line)) {
      const r = mdList(lines, i, mdPath);
      out.push(r.html); i = r.next;
      continue;
    }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() &&
      !/^\s*(`{3,}|~{3,})/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !/^\s*&gt;/.test(lines[i]) && !LI_RE.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${buf.map((l) => mdInline(l, mdPath)).join("<br>")}</p>`);
  }
  return out.join("");
}
function mdRender(src, mdPath) {
  return mdBlocks(escFile(src).split("\n"), mdPath ?? null);
}

function rich(src) {
  return mdRender(src, null);
}
