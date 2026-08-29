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

const S = {
  state: null,
  streaming: false,
  streamingTool: null,
  retrying: null,             // {attempt, maxAttempts} | null
  images: [],                 // pending attachments [{name, mediaType, data}]
  lastUserPrompt: null,       // for retry button
  models: [],
  resources: { skills: [], prompts: [], extensions: [] },
  assistant: null,            // current assistant DOM container
  assistantText: "",
  thinking: null,
  toolCards: new Map(),       // toolCallId -> {card, outEl, descEl, path, startedAt, toolName}
  queued: { steering: [], followUp: [] },
  sessions: [],
  renderQueued: false,
  agentStartedAt: 0,
  /* workspace / preview */
  activity: [],               // [{path, tool, time, diff}]
  treeData: null,
  expanded: new Set(),        // expanded folder paths
  selectedFile: null,
  previewFile: null,
  treeTimer: null,
  detailMode: "activity",     // activity | file | diff
};

const TOOL_ICONS = {
  read: "◈", write: "✎", edit: "✧", bash: "❯", powershell: "❯",
  grep: "⌕", find: "⌕", ls: "▤", todo: "☑",
};
const TOOL_COLORS = {
  read: "#8be9ff", bash: "#fcd34d", powershell: "#fcd34d", edit: "#a78bfa",
  write: "#6ee7b7", grep: "#f0a6ff", find: "#93c5fd", ls: "#94a3b8",
};
const copyCache = new WeakMap(); // assistant container -> text (for copy button)

/* ============================================================
   boot
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  requestAnimationFrame(() => document.body.classList.add("enter"));
  Nebula.init($("#nebulaCanvas"));
  wireUI();
  wirePi();
  refreshAll();
  loadTree();
  renderActivity();
  setInterval(updateZoomLabel, 200);
});

async function refreshAll() {
  const st = await window.halo.getState();
  applyState(st?.data || st);
  await Promise.all([loadSessions(), loadResources()]);
}

/* ============================================================
   state application
   ============================================================ */
function applyState(st) {
  if (!st) return;
  S.state = st;
  if (st.cwd) {
    const name = st.cwd.split(/[\\/]/).filter(Boolean).pop() || st.cwd;
    $("#projectName").textContent = name;
    $("#projectChip").title = st.cwd;
  }
  const m = st.model;
  $("#modelName").textContent = m ? m.name : "未配置模型";
  $("#modelMeta").textContent = m ? `${m.provider} · ${fmtTokens(m.contextWindow)} ctx` : "点击选择模型";

  const tl = st.thinkingLevel || "off";
  $("#thinkLabel").textContent = THINK_LABELS[tl] || tl;
  $("#thinkChip").textContent = THINK_LABELS[tl] || tl;

  renderStats(st.usage);
  $("#ctxBadge").textContent = `${st.messageCount || 0} 条`;

  const file = st.sessionFile ? st.sessionFile.split(/[\\/]/).pop().replace(/\.jsonl$/, "") : null;
  const label = file ? friendlySession(file) : "新会话";
  $("#nebSessionName").textContent = label;
  $("#chatTitle").textContent = label;
  $("#nebSessionName").parentElement.title = st.sessionFile || "";

  const ready = !!st.ready;
  $("#input").placeholder = ready
    ? "描述你要完成的任务…  Enter 发送 · Shift+Enter 换行"
    : "核心唤醒中，请稍候…";
  $("#btnSend").disabled = !ready;
  $("#btnSend").classList.toggle("dim", !ready);

  setStreamingUI(st.isStreaming || S.streaming);
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

function agentStatusText() {
  const secs = S.agentStartedAt ? Math.floor((Date.now() - S.agentStartedAt) / 1000) : 0;
  const t = secs > 0 ? ` · ${secs}s` : "";
  if (S.retrying) return `自动重试中 (${S.retrying.attempt}/${S.retrying.maxAttempts})`;
  if (S.streamingTool) return `正在调用 ${S.streamingTool}`;
  if (S.streaming) return `正在思考…${t}`;
  return "Agent 已就绪";
}

let _statusTimer = null;
function startStatusTicker() {
  stopStatusTicker();
  _statusTimer = setInterval(() => {
    $("#agentSub").textContent = agentStatusText();
    // also refresh the nebula pill status (was static before)
    $("#nebStatus").textContent = S.retrying ? "重试中" : S.streamingTool ? S.streamingTool : "思考中";
  }, 500);
}
function stopStatusTicker() {
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
}

function setStreamingUI(v) {
  S.streaming = v;
  $("#btnSend").classList.toggle("streaming", v);
  $("#btnSend").title = v ? "中止 (Esc)" : "发送";
  $("#nebPulse").parentElement.classList.toggle("busy", v);
  $("#agentOrb").classList.toggle("busy", v);
  $("#agentTitle").textContent = v ? "核心运转中" : "核心待命";
  $("#agentSub").textContent = agentStatusText();
  // pill status now tracks the real phase instead of a static "就绪"
  $("#nebStatus").textContent = v ? (S.retrying ? "重试中" : S.streamingTool ? S.streamingTool : "思考中") : "就绪";
  if (v && !_statusTimer) startStatusTicker();
  if (!v) stopStatusTicker();
  Nebula.setBusy(v);
}

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
  window.halo.onState((st) => applyState(st));
  window.halo.onError?.((e) => toast(e?.message || "发生错误", "err"));
  window.halo.onWinState?.(({ maximized }) => {
    $("#winMax").title = maximized ? "还原" : "最大化";
    $("#winMax").classList.toggle("maxed", maximized);
  });
}

function handlePiEvent(event) {
  if (!event) return;
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
        hideHero();
        setStreamingUI(true);
        // immediate "process" feedback: thinking shell with breathing
        // placeholder, so silent gateways (e.g. buffered GLM) still feel alive
        ensureAssistantContainer();
        showThinkingPlaceholder();
        break;
      case "agent_end":
        S.streamingTool = null;
        if (!event.willRetry) setStreamingUI(false);
        else setStreamingUI(true); // keep busy visual during retry gap
        finalizeAssistant();
        refreshState();
        break;

      case "auto_retry_start":
        S.retrying = { attempt: event.attempt, maxAttempts: event.maxAttempts };
        notice(`请求失败，自动重试中 (${event.attempt}/${event.maxAttempts}) …`, "warn");
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
        finalizeAssistant();
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
      case "compaction_start": notice("正在压缩上下文…", ""); break;
      case "compaction_end": notice("上下文已压缩 ✓", "ok"); break;
    }
  }

  async function refreshState() {
  const st = await window.halo.getState();
  if (st?.data) applyState(st.data);
}

/* ---- assistant message bubbles ---- */
function ensureAssistantContainer() {
  if (S.assistant) return S.assistant;
  S.assistant = buildAssistantContainer();
  S.assistantText = S.assistantText || "";
  return S.assistant;
}

/* breathing placeholder inside the bubble until the first real delta lands */
function showThinkingPlaceholder() {
  if (!S.assistant) return;
  const bubble = $(".bubble", S.assistant);
  if ($(".ph-line", bubble)) return;
  const ph = document.createElement("div");
  ph.className = "ph-line";
  ph.innerHTML = `<span class="ph-bar" style="width:72%"></span><span class="ph-bar" style="width:48%"></span><span class="ph-bar" style="width:60%"></span>`;
  bubble.appendChild(ph);
}

function removeThinkingPlaceholder() {
  if (!S.assistant) return;
  $(".ph-line", S.assistant)?.remove();
}

function onMessageStart(msg) {
  if (!msg || msg.role !== "assistant") return; // user messages are rendered locally
  ensureAssistantContainer();
  const tb = $(".think-block", S.assistant);
  tb.hidden = true;
  S.thinking = { el: $(".think-body", S.assistant), buf: "" };
}

function onMessageUpdate(ev) {
  if (!ev) return;
  if (ev.type === "text_delta") {
    if (!S.assistant) ensureAssistantContainer(); // A3 fallback
    removeThinkingPlaceholder();
    S.assistantText += ev.delta || "";
    scheduleRender();
  } else if (ev.type === "thinking_delta") {
    if (!S.assistant) ensureAssistantContainer();
    removeThinkingPlaceholder();
    const tb = $(".think-block", S.assistant);
    tb.hidden = false;
    if (!tb.open) tb.open = true; // keep the detailed thinking visible while streaming
    const body = $(".think-body", S.assistant);
    body.classList.add("streaming");
    S.thinking = S.thinking || { buf: "" };
    S.thinking.buf += ev.delta || "";
    body.textContent = S.thinking.buf;
    body.scrollTop = body.scrollHeight;
  }
}

function onMessageEnd(msg) {
  if (!msg || msg.role !== "assistant") return;

  // A1: surface model errors that pi reports on the message itself
  if (msg.stopReason === "error" && msg.errorMessage) {
    // discard the empty assistant shell entirely, then show the error card
    S.assistant?.remove();
    S.assistant = null;
    S.assistantText = "";
    renderModelError(msg.errorMessage, { provider: msg.provider, model: msg.model });
    refreshState();
    return;
  }

  removeThinkingPlaceholder();
  if (S.assistant) $(".think-body", S.assistant)?.classList.remove("streaming");
  // restore thinking from the final message when the stream never sent deltas
  if (S.assistant && !S.thinking?.buf && Array.isArray(msg.content)) {
    const think = msg.content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("");
    if (think) {
      const tb = $(".think-block", S.assistant);
      tb.hidden = false;
      S.thinking = S.thinking || {};
      S.thinking.buf = think;
      $(".think-body", S.assistant).textContent = think;
    }
  }

  // A3: rebuild from final content if we never streamed
  if (S.assistant && !S.assistantText && Array.isArray(msg.content)) {
    const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (text) { S.assistantText = text; scheduleRender(); }
  }
  renderAssistant();
  finalizeAssistant();
}

function buildAssistantContainer() {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.innerHTML = `
    <div class="who"><span class="avatar">π</span><span>星环</span></div>
    <details class="think-block" hidden>
      <summary class="think-head"><span class="diamond">◆</span><span>思考过程</span></summary>
      <div class="think-body"></div>
    </details>
    <div class="bubble"><span class="txt"></span><span class="caret"></span></div>
    <button class="copy-btn" title="复制回复">⧉ 复制</button>`;
  $(".copy-btn", wrap).addEventListener("click", () => {
    navigator.clipboard.writeText(copyCache.get(wrap) || "").then(() => toast("已复制到剪贴板", "ok"));
  });
  $("#messages").appendChild(wrap);
  scrollDown();
  return wrap;
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
  if (!S.assistant) return;
  const txt = $(".txt", S.assistant);
  txt.innerHTML = rich(S.assistantText);
  if (S.assistant) copyCache.set(S.assistant, S.assistantText);
  scrollDown();
}

function finalizeAssistant(skipCleanup = false) {
  if (!S.assistant) return;
  removeThinkingPlaceholder();
  $(".caret", S.assistant)?.remove();
  if (!S.assistantText.trim()) {
    // empty prose: drop the bubble (keep the thinking block if present)
    $(".bubble", S.assistant)?.remove();
    const hasThink = !$(".think-block", S.assistant).hidden;
    if (!hasThink && !skipCleanup) S.assistant.remove();
  }
  S.assistant = null;
  S.assistantText = "";
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
  $("#messages").appendChild(n);
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
  } catch (e) { notice(`发送失败：${e?.message || e}`, "err"); }
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

function onToolStart(ev) {
  const { toolCallId, toolName, args } = ev;
  S.streamingTool = toolName;
  setStreamingUI(true);
  hideHero();

  const color = TOOL_COLORS[toolName] || "#a5b4fc";
  const icon = TOOL_ICONS[toolName] || "✦";
  const card = document.createElement("div");
  card.className = "tool-card";
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-ico" style="color:${color}">${icon}</span>
      <span class="tool-name">${esc(toolName)}</span>
      <span class="tool-desc">${esc(trunc(toolDesc(toolName, args), 90))}</span>
      <span class="tool-elapsed"></span>
      <span class="tool-state"><span class="spin"></span><span class="label">运行中</span></span>
    </div>
    <div class="tool-out" hidden></div>`;
  $(".tool-head", card).addEventListener("click", () => {
    const out = $(".tool-out", card);
    if (out.dataset.has) out.hidden = !out.hidden;
  });
  $("#messages").appendChild(card);
  S.toolCards.set(toolCallId, {
    card,
    out: $(".tool-out", card),
    desc: $(".tool-desc", card),
    elapsedEl: $(".tool-elapsed", card),
    path: (args && (args.path || args.file)) || "",
    command: (args && (args.command || args.cmd)) || "",
    toolName,
    startedAt: Date.now(),
  });
  Nebula.addToolNode({ id: toolCallId, toolName });
  scrollDown();
}

function onToolUpdate(ev) {
  const rec = S.toolCards.get(ev.toolCallId);
  Nebula.updateToolNode(ev.toolCallId);
  if (!rec) return;
  const args = ev.partial?.args || ev.args;
  if (args) rec.desc.textContent = trunc(toolDesc(rec.toolName, args), 90);
}

function onToolEnd(ev) {
  const { toolCallId, isError, result } = ev;
  const rec = S.toolCards.get(toolCallId);
  S.streamingTool = null;
  setStreamingUI(true);
  Nebula.endToolNode(toolCallId, isError);

  if (!rec) return;

  // A8: artifact filename from cached args
  const base = rec.path ? rec.path.split(/[\\/]/).pop() : "";
  if (!isError && base && /\.[a-z0-9]{1,6}$/i.test(base) && (rec.toolName === "write" || rec.toolName === "edit")) {
    Nebula.addArtifact({ name: base });
  }

  // elapsed badge
  const secs = (Date.now() - rec.startedAt) / 1000;
  rec.elapsedEl.textContent = secs >= 1 ? `${secs.toFixed(1)}s` : "";

  const state = $(".tool-state", rec.card);
  state.classList.add(isError ? "error" : "done");
  state.innerHTML = `<span class="mark">${isError ? "✕" : "✓"}</span><span class="label">${isError ? "失败" : "完成"}</span>`;

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
      switchCenter("preview");
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
const toPiImage = (i) => ({ type: "image", source: { type: "base64", mediaType: i.mediaType, data: i.data } });

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
    if (r?.ok) notice("上下文已压缩 ✓", "ok");
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
  hideHero();

  try {
    await window.halo.prompt(text, sentImages.length ? { images: sentImages.map(toPiImage) } : {});
  } catch (e) {
    notice(`发送失败：${e?.message || e}`, "err");
    // A4: rollback so the user doesn't lose their text
    input.value = text;
    S.images = sentImages;
    renderAttachments();
    autoGrow();
    setStreamingUI(false);
  }
}

function renderUserMsg(text, images) {
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
    if (m.role === "user") renderUserMsg(text, []);
    else if (m.role === "assistant") {
      const c = buildAssistantContainer();
      $(".caret", c)?.remove();
      $(".txt", c).innerHTML = rich(text);
      copyCache.set(c, text);
    }
  }
  notice(`已载入历史 · ${msgs.length} 条消息`, "");
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
    const b = document.createElement("button");
    b.className = "session-item";
    const file = (s.file || "").split(/[\\/]/).pop().replace(/\.jsonl$/, "");
    b.innerHTML = `<span class="s-name">${esc(s.name || friendlySession(file))}</span>
      <span class="s-meta">${s.modified ? new Date(s.modified).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}${s.messageCount != null ? " · " + s.messageCount + "条" : ""}</span>`;
    b.addEventListener("click", () => {
      if (S.streaming) return toast("任务进行中，无法切换会话", "err");
      openSession(s.file);
    });
    list.appendChild(b);
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
  notice("新会话已开启 ✦", "ok");
  loadSessions();
}

function clearChat() {
  $("#messages").innerHTML = "";
  S.toolCards.clear();
  S.assistant = null;
  S.assistantText = "";
  S.lastUserPrompt = null;
  S.activity = [];
  S.detailMode = "activity";
  renderActivity();
  Nebula.reset();
  Nebula.setZoom(1);
  showHero();
}

async function loadResources() {
  const r = await window.halo.listResources();
  S.resources = r?.data || { skills: [], prompts: [], extensions: [] };
  const fill = (sel, arr, fmt) => {
    const el = $(sel);
    if (!arr.length) { el.innerHTML = `<div class="res-empty">—</div>`; return; }
    el.innerHTML = arr.map(fmt).join("");
  };
  fill("#skillList", S.resources.skills, (s) => `<button class="res-chip" title="${esc(s.description || s.name)}" data-skill="${esc(s.name)}">✦ ${esc(s.name)}</button>`);
  fill("#promptList", S.resources.prompts, (p) => `<button class="res-chip" data-prompt="${esc(p.name)}" title="${esc(p.description || "")}">◈ ${esc(p.name)}</button>`);
  fill("#extList", S.resources.extensions, (x) => `<span class="res-chip" title="已加载扩展">⬡ ${esc(x.name)}</span>`);

  $$("#skillList [data-skill]").forEach((b) =>
    b.addEventListener("click", () => { $("#input").value = `/skill:${b.dataset.skill} `; $("#input").focus(); }));
  $$("#promptList [data-prompt]").forEach((b) =>
    b.addEventListener("click", () => { $("#input").value = `/${b.dataset.prompt} `; $("#input").focus(); }));
}

/* ---- models ---- */
async function loadModels() {
  const r = await window.halo.listModels();
  S.models = (r?.data || []).filter((m) => !m.error);
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
      const isCur = cur && cur.provider === m.provider && cur.id === m.id;
      const b = document.createElement("button");
      b.className = "model-item" + (isCur ? " current" : "");
      b.innerHTML = `
        <span class="mi-check">${isCur ? "●" : ""}</span>
        <span><div class="mi-name">${esc(m.name)}</div><div class="mi-id">${esc(m.provider)}/${esc(m.id)}</div></span>
        <span class="mi-meta">${m.reasoning ? "reasoning · " : ""}${fmtTokens(m.contextWindow)}</span>`;
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

  // sidebar tabs
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => {
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    const tab = btn.dataset.tab;
    $$(".side-section").forEach((p) => p.classList.toggle("active", p.dataset.pane === tab));
  }));

  // quick actions
  $("#qNew").addEventListener("click", newSession);
  $("#btnNewSession").addEventListener("click", newSession);
  $("#qModel").addEventListener("click", () => { loadModels(); openModal("modelModal"); });
  $("#qCompact").addEventListener("click", () => { $("#input").value = "/compact"; send(); });
  $("#qHelp").addEventListener("click", () => openModal("helpModal"));

  // model card
  $("#modelBtn").addEventListener("click", () => { loadModels(); openModal("modelModal"); });
  $("#thinkBtn").addEventListener("click", () => { renderThinkList(); openModal("thinkModal"); });
  $("#modelSearch").addEventListener("input", (e) => renderModelList(e.target.value));

  // nebula toolbar
  $("#toolNew").addEventListener("click", newSession);
  $("#toolImage").addEventListener("click", attachImages);
  $("#btnAttach").addEventListener("click", attachImages);
  $("#toolFolder").addEventListener("click", pickProject);
  $("#projectChip").addEventListener("click", pickProject);
  $("#toolHelp").addEventListener("click", () => openModal("helpModal"));

  // zoom + toggles (B3: dblclick resets)
  $("#zoomIn").addEventListener("click", () => Nebula.setZoom(Nebula.getZoom() * 1.18));
  $("#zoomOut").addEventListener("click", () => Nebula.setZoom(Nebula.getZoom() / 1.18));
  $("#zoomVal").addEventListener("dblclick", () => Nebula.setZoom(1));
  $("#orbitsToggle").addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("on");
    Nebula.toggleOrbits(on);
  });
  $("#labelsToggle").addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("on");
    Nebula.toggleLabels(on);
  });

  // chat header
  $("#btnCompact").addEventListener("click", () => { $("#input").value = "/compact"; send(); });

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
   center: workspace / preview / nebula
   ============================================================ */
function switchCenter(pane) {
  $$(".ctab").forEach((b) => b.classList.toggle("active", b.dataset.cpane === pane));
  $$(".cpane").forEach((p) => p.classList.toggle("active", p.id === "cpane-" + pane));
  if (pane === "nebula") requestAnimationFrame(() => Nebula.resize());
  if (pane === "workspace") loadTree();
}

function wireCenter() {
  $$(".ctab").forEach((b) => b.addEventListener("click", () => switchCenter(b.dataset.cpane)));
  $("#treeRefresh").addEventListener("click", () => loadTree(true));
  $("#pvReload").addEventListener("click", () => setPreview(S.previewFile, true));
  $("#pvOpen").addEventListener("click", () => { if (S.previewFile) window.halo.openPath(S.previewFile); });
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

function renderTree() {
  const el = $("#wsTree");
  if (!S.treeData) { el.innerHTML = `<div class="res-empty">无法读取目录</div>`; return; }
  el.innerHTML = "";
  const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  const changedSet = new Set(S.activity.map((a) => norm(a.path)));
  const build = (nodes, depth, container) => {
    for (const n of nodes) {
      const row = document.createElement("div");
      row.className = "trow" + (n.dir ? " dir" : " file") + (S.expanded.has(n.path) ? " open" : "") + (changedSet.has(norm(n.path)) ? " changed" : "") + (S.selectedFile === n.path ? " selected" : "");
      row.style.paddingLeft = 8 + depth * 14 + "px";
      row.innerHTML = n.dir
        ? `<span class="arrow">▶</span><span class="fic">▸</span><span class="fname">${esc(n.name)}</span>`
        : `<span class="arrow"></span><span class="fic">·</span><span class="fname">${esc(n.name)}</span><span class="fsize">${fmtSize(n.size || 0)}</span>`;
      row.title = n.path;
      row.addEventListener("click", () => {
        if (n.dir) {
          S.expanded.has(n.path) ? S.expanded.delete(n.path) : S.expanded.add(n.path);
          renderTree();
        } else {
          S.selectedFile = n.path;
          renderTree();
          openInDetail(n.path);
        }
      });
      container.appendChild(row);
      if (n.dir && S.expanded.has(n.path) && n.children?.length) {
        const kid = document.createElement("div");
        kid.className = "tree-kids";
        build(n.children, depth + 1, kid);
        container.appendChild(kid);
      }
    }
  };
  build(S.treeData.tree, 0, el);
  if (S.treeData.truncated) {
    const tip = document.createElement("div");
    tip.className = "res-empty";
    tip.textContent = "… 文件过多已截断";
    el.appendChild(tip);
  }
}

/* ---- detail pane: activity (default) / file / diff ---- */
function renderDetail() {
  const el = $("#wsDetail");
  if (S.detailMode === "file" && S.selectedFile) return showFileViewer(S.selectedFile);
  if (S.detailMode === "diff" && S.diffItem) return showDiffView(S.diffItem);
  renderActivity();
}

function renderActivity() {
  const el = $("#wsDetail");
  el.innerHTML = `
    <div class="ws-detail-head"><b>本次会话改动</b><span class="chat-badge">${S.activity.length} 个文件</span></div>
    ${S.activity.length === 0
      ? `<div class="act-empty">
           <div class="big">⌘</div>
           <p>agent 写入 / 编辑的文件会出现在这里</p>
           <p class="dim">左侧是项目文件树，点击文件可查看内容；HTML / 图片 / Markdown 会在预览页打开</p>
         </div>`
      : `<div class="act-list">${S.activity.map((a, i) => `
          <button class="act-item ${a.diff ? "hasdiff" : ""}" data-i="${i}">
            <span class="aic" style="color:${TOOL_COLORS[a.tool] || "#a5b4fc"}">${TOOL_ICONS[a.tool] || "✦"}</span>
            <span><div class="aname">${esc(a.path.split(/[\\\\/]/).pop())}</div>
            <div class="atool">${a.tool === "write" ? "新建" : "编辑"}${a.diff ? " · 含 diff" : ""}</div></span>
            <span class="atime">${new Date(a.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
          </button>`).join("")}</div>`}`;
  $$("#wsDetail .act-item").forEach((b) => b.addEventListener("click", () => {
    const a = S.activity[+b.dataset.i];
    if (a?.diff) showDiffView(a); else openInDetail(a.path);
  }));
}

const PREVIEWABLE = ["html", "htm", "png", "jpg", "jpeg", "gif", "webp", "svg", "md", "markdown"];

async function openInDetail(p) {
  S.detailMode = "file";
  S.selectedFile = p;
  const ext = p.split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return setPreview(p);
  if (["html", "htm"].includes(ext)) { setPreview(p); switchCenter("preview"); return; }
  if (["md", "markdown"].includes(ext)) { setPreview(p); switchCenter("preview"); return; }
  switchCenter("workspace");
  const el = $("#wsDetail");
  el.innerHTML = `<div class="ws-detail-head"><b>${esc(p.split(/[\\\\/]/).pop())}</b><span class="dim-path">${esc(p)}</span>
    <span class="ct-spacer"></span><button class="mini-btn" id="dvPreview">◇ 预览</button>
    <button class="mini-btn" id="dvOpen">↗ 编辑器</button></div>
    <div class="file-view"><div class="fv-note">加载中…</div></div>`;
  $("#dvPreview").addEventListener("click", () => { setPreview(p); switchCenter("preview"); });
  $("#dvOpen").addEventListener("click", () => window.halo.openPath(p));
  const r = await window.halo.readFile(p);
  const data = r?.data;
  if (!data) {
    $(".file-view", el).innerHTML = `<div class="fv-note">无法读取：${esc(r?.error || "")}（二进制或超出大小限制）</div>`;
    return;
  }
  const lines = data.content.split("\n");
  $(".file-view", el).innerHTML =
    lines.slice(0, 2000).map((l, i) =>
      `<div class="fv-line"><span class="ln">${i + 1}</span><span class="lc">${esc(l) || " "}</span></div>`).join("") +
    (data.truncated || lines.length > 2000 ? `<div class="fv-note">文件过长，仅显示前 2000 行${data.truncated ? "（且已截断）" : ""}</div>` : "");
}

function showDiffView(item) {
  S.detailMode = "diff";
  S.diffItem = item;
  switchCenter("workspace");
  const el = $("#wsDetail");
  el.innerHTML = `
    <div class="ws-detail-head"><b>${esc(item.path.split(/[\\\\/]/).pop())}</b>
      <span class="dim-path">${esc(item.path)}</span>
      <span class="ct-spacer"></span>
      <button class="mini-btn" id="diffBack">← 返回列表</button>
      <button class="mini-btn" id="diffFile">查看全文</button></div>
    <div class="file-view">${esc(item.diff).split("\n").map((l) => {
      let cls = "";
      if (l.startsWith("+") && !l.startsWith("+++")) cls = "diff-add";
      else if (l.startsWith("-") && !l.startsWith("---")) cls = "diff-del";
      else if (l.startsWith("@@")) cls = "diff-hunk";
      return `<div class="fv-line"><span class="ln"> </span><span class="lc ${cls}">${l || " "}</span></div>`;
    }).join("")}</div>`;
  $("#diffBack").addEventListener("click", () => { S.detailMode = "activity"; renderActivity(); });
  $("#diffFile").addEventListener("click", () => openInDetail(item.path));
}

function recordActivity(rec) {
  S.activity.unshift(rec);
  if (S.activity.length > 60) S.activity.pop();
  if (S.detailMode !== "activity") return; // don't yank the user out of a viewer
  renderActivity();
}

/* ---- preview ---- */
const previewURL = (p) => "halo-preview://local/" + encodeURI(p.replace(/\\/g, "/")).replace(/^([A-Za-z]:)/, "$1");

async function setPreview(p, force) {
  if (!p) return;
  if (!force && S.previewFile === p) { switchCenter("preview"); return; }
  S.previewFile = p;
  const ext = p.split(".").pop().toLowerCase();
  $("#pvName").textContent = p.split(/[\\\\/]/).pop();
  const body = $("#pvBody");
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    body.innerHTML = `<img class="pv-img" src="${previewURL(p)}" />`;
  } else if (["md", "markdown"].includes(ext)) {
    body.innerHTML = `<div class="md-view">加载中…</div>`;
    const r = await window.halo.readFile(p);
    body.innerHTML = r?.data
      ? `<div class="md-view">${rich(r.data.content)}</div>`
      : `<div class="pv-empty"><p>无法读取：${esc(r?.error || "")}</p></div>`;
  } else {
    body.innerHTML = `<iframe src="${previewURL(p)}"></iframe>`;
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
async function attachImages() {
  const r = await window.halo.pickImages();
  const imgs = r?.data || [];
  S.images.push(...imgs);
  renderAttachments();
}

function addImageFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    S.images.push({ name: file.name, mediaType: file.type, data: String(reader.result).split(",")[1] });
    renderAttachments();
  };
  reader.readAsDataURL(file);
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
async function pickProject() {
  if (S.streaming) return toast("任务进行中，无法切换项目", "err");
  const r = await window.halo.pickProject(S.state?.cwd);
  const dir = r?.data;
  if (!dir || dir === S.state?.cwd) return;
  clearChat();
  S.previewFile = null;
  $("#pvBody").innerHTML = `<div class="pv-empty"><div class="pv-empty-ico">◇</div><p>agent 生成的 HTML / 图片 / Markdown 会在这里实时预览</p></div>`;
  $("#pvName").textContent = "未选择文件";
  S.expanded.clear();
  await loadTree(true);
  await loadSessions();
  await loadResources();
  notice(`已切换项目 · ${dir.split(/[\\/]/).pop()}`, "ok");
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
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
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
  const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 90;
  if (force || nearBottom) m.scrollTop = m.scrollHeight + 400;
}

function hideHero() { $("#nebulaHero").classList.add("hidden"); }
function showHero() { $("#nebulaHero").classList.remove("hidden"); }

function updateZoomLabel() {
  $("#zoomVal").textContent = Math.round(Nebula.getZoom() * 100) + "%";
}

/* ============================================================
   tiny rich text (safe markdown-lite)
   ============================================================ */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function rich(src) {
  let s = esc(src);
  const blocks = [];
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.split(/\n{2,}/).map((p) => {
    const b = p.match(/^\u0000B(\d+)\u0000$/);
    if (b) return blocks[+b[1]];
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  }).join("");
  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[+i]);
  return s;
}
