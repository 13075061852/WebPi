import { artifactPath, replyArtifacts, decorateArtifactCard } from "./artifacts.mjs";
import { initAppUpdates } from './app-updates.mjs';
import { initStartupProgress } from './startup.mjs';
import { websiteURL, renderWebsiteCards, mountWebsiteBrowser } from './website-preview.mjs';
import { userMessageText, userMessageParts } from "./user-message.mjs";
import { initEnvironmentSettings } from "./environment-settings.mjs";
import { initVideoSettings } from "./video-settings.mjs";
import { videoBalanceText } from "./video-balance.mjs";
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
let environmentSettings;
let videoSettings;

/* ---- 渲染层常量（与主进程 LIMITS 对应，收敛魔法数字） ---- */
const CONFIRM_RESET_MS = 2600;        // 两步删除确认：未二次确认时恢复的毫秒数
const TRUNC_TOOL_ARG = 120;           // 工具参数展示截断长度
const IMG_DOWNSCALE = { maxBytes: 400 * 1024, maxEdge: 1600, quality: 0.85 }; // 附件图片降采样阈值

// 预览帧触摸脚本回报滚动位置（调试/验证用）
window.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.__haloScroll) window.__haloTouchState = d.__haloScroll;
  if (d && d.__haloOs) window.__haloOs = d.__haloOs;
});

const S = {
  state: null,
  streaming: false,
  usageDays: 7,
  usageCache: new Map(),      // days -> 统计结果（切换天数避免重复扫描）
  streamingTool: null,
  retrying: null,             // {attempt, maxAttempts} | null
  images: [],                 // pending attachments [{name, mediaType, data}]
  composerRevision: 0,        // protects a newer text/attachment draft from delayed send failures
  lastUserPrompt: null,       // for retry button
  models: [],
  resources: { skills: [], prompts: [], extensions: [] },
  assistant: null,            // current per-message body inside the turn container
  turn: null,                 // Claude-style turn block: one avatar, content flows downward
  assistantText: "",
  thinking: null,
  toolCards: new Map(),       // toolCallId -> {card, outEl, descEl, path, startedAt, toolName}
  queued: { steering: [], followUp: [] },
  pkgQuery: "", pkgType: "all", pkgPage: 1, pkgItems: [], pkgTotal: 0, pkgLoaded: false, pkgInstalledList: [],
  previewMode: "render", // 预览模式：render（渲染页面）| source（源代码）
  sessions: [],
  renderQueued: false,
  agentStartedAt: 0,
  pendingRestore: false,      // 核心就绪后待执行的会话恢复
  /* workspace / preview */
  activity: [],               // [{path, tool, time, diff}]
  treeData: null,
  expanded: new Set(),        // expanded folder paths
  selectedFile: null,
  previewFile: null,
  treeTimer: null,
  quota: { provider: null, data: null },   // 当前模型剩余额度（每轮对话结束动态刷新）
  creating: null,             // { parent: string|null, kind: "file"|"dir" } 行内新建状态
  sessionSwitchSeq: 0,        // 丢弃快速切换产生的过期恢复结果
  switchingSession: false,   // 切换期间由历史快照接管，避免旧会话事件串入新视图
};

/* ---------- theme: 黑 / 白 ---------- */
function applyTheme(t, { persist = true } = {}) {
  const selected = [...Object.keys(window.HALO_THEME_PALETTES || {}), 'light', 'dark', 'nebula', 'mist', 'dunes', 'scholar', 'studio', 'garden', 'spacepig', 'blueprint', 'executive'].includes(t) ? t : 'dark';
  document.documentElement.dataset.theme = window.HALO_THEME_PALETTES?.[selected] || (['light', 'mist', 'dunes', 'scholar', 'studio', 'garden'].includes(selected) ? 'light' : 'dark');
  document.documentElement.dataset.wallpaper = [...Object.keys(window.HALO_THEME_PALETTES || {}), 'nebula', 'mist', 'dunes', 'scholar', 'studio', 'garden', 'spacepig', 'blueprint', 'executive'].includes(selected) ? selected : '';
  if (persist) { try { localStorage.setItem("halo-theme", selected); } catch {} }
  document.dispatchEvent(new CustomEvent("themechange"));
}

/* ============================================================
   boot
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  try {
  document.body.classList.add("enter");
  wireUI();
  initAppUpdates();
  wirePi();
  initStartupProgress({ onRetry: restoreInitialWorkspace });
  // Install listeners before notifying main. Core loading runs behind the launch window.
  S.pendingRestore = true;
  requestAnimationFrame(() => {
    void window.halo.rendererReady?.().catch(() => {});
    // Settings/account/network work can wait until the first interactive frame.
    const background = () => {
      environmentSettings = initEnvironmentSettings();
      videoSettings = initVideoSettings({ onSaved: () => void loadVideoBalance() });
      void loadVideoBalance();
      updateAuthSummary();
    };
    if (window.requestIdleCallback) window.requestIdleCallback(background, { timeout: 2000 });
    else setTimeout(background, 0);
  });
  initServerUI();
  void window.halo.getState().then(reply => {
    if (!reply?.ok) throw Error(reply?.error || '无法读取启动状态');
    if (!S.state?.ready || reply.data?.ready) applyState(reply.data);
  }).catch(reportWorkspaceFailure);
  // 对齐分割线：sidebar 登录区顶线与预览区下方设备切换条顶线在同一水平线
  const devicesBar = document.querySelector(".pv-devices"), modelCard = $("#modelCard");
  if (devicesBar && modelCard && window.ResizeObserver) {
    const syncFoot = () => { modelCard.style.minHeight = devicesBar.offsetHeight + "px"; };
    new ResizeObserver(syncFoot).observe(devicesBar);
    syncFoot();
  }
  } catch (error) {
    console.error('[halo] renderer initialization failed:', error);
    void window.halo.rendererFailed?.(String(error?.message || error));
  }
});

let initialWorkspacePromise;
function reportWorkspaceFailure(error) {
  const message = String(error?.message || error);
  void window.halo.workspaceReady?.(message).catch(() => {});
  toast(message, 'err');
}
function restoreInitialWorkspace() {
  if (initialWorkspacePromise) return initialWorkspacePromise;
  S.pendingRestore = false;
  initialWorkspacePromise = (async () => {
    const reply = await window.halo.getState();
    if (!reply?.ok) throw Error(reply?.error || '无法读取会话状态');
    const state = S.state?.ready ? S.state : reply.data;
    if (!state?.ready) { S.pendingRestore = true; return; }
    // Restore once even if a ready event races the initial state request.
    applyState(state);
    await Promise.all([loadSessions(), loadResources()]);
    await restoreWorkspace();
    await Promise.all([loadTree(true), loadProjects()]);
    // Commit the restored layout before main replaces the small launch window.
    await new Promise(resolve => requestAnimationFrame(resolve));
    await window.halo.workspaceReady?.();
  })().catch(reportWorkspaceFailure).finally(() => { initialWorkspacePromise = null; });
  return initialWorkspacePromise;
}

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
let serverListRequest = 0;
let draggedServer = null;
const collapsedServers = new Set();
let browsingServerId = null, portServerId = null, portRequest = 0, portPreviewRequest = 0;
const portCache = new Map();
let selectedPortKey = null;
let previewService = null;
function openWebsite(value) {
  const url = websiteURL(value); if (!url) return;
  const request = ++portPreviewRequest;
  S.previewFile = null; selectedPortKey = null; updatePortSelection();
  previewService = {kind:'website', url, status:'loading'};
  $('#btnOpenFile').hidden = true; $('#pvMode').hidden = true;
  $('#pvName').textContent = new URL(url).hostname;
  mountWebsiteBrowser($('#pvBody'), url, state => {
    if (request !== portPreviewRequest) return;
    Object.assign(previewService, state, {status:'loaded'});
    $('#pvName').textContent = state.title || new URL(state.url).hostname;
  }, mediaPreviewShell);
}
document.addEventListener('click', event => {
  const link = event.target.closest('.md a[href]');
  if (!link || !websiteURL(link.href)) return;
  event.preventDefault(); openWebsite(link.href);
});
function currentPreviewContext() {
  if (S.previewFile) return {kind:'file', file:S.previewFile};
  if (!previewService) return null;
  const context = {...previewService, device:currentPreviewDevice()};
  try {
    const guest = document.querySelector('#pvBody webview');
    if (guest) {context.url=guest.getURL(); context.title=guest.getTitle(); context.guestId=guest.getWebContentsId();}
  } catch { /* Navigation may still be loading. */ }
  return context;
}
// Run once after the retry loop settles, including background sessions on this server.
function refreshCompletedPreview({event, sessionId, serverId}) {
  if (event?.type !== "agent_settled") return;
  if (previewService) {
    if (!serverId || serverId !== previewService.serverId) return;
    const guest = document.querySelector('#pvBody webview');
    if (!guest) return;
    try {
      guest.reloadIgnoringCache();
      previewService.status = 'loading';
    } catch { /* The preview may have been detached during navigation. */ }
    return;
  }
  if (!serverId && sessionId === S.state?.sessionId && !S.switchingSession && S.previewFile) {
    void setPreview(S.previewFile, true);
  }
}
const portKey = (id, item) => JSON.stringify([id, item.protocol, item.address, item.port]);
function updatePortSelection() {
  $$("#serverPorts .port-row").forEach(row => {
    const selected = row.dataset.portKey === selectedPortKey;
    row.classList.toggle("active", selected);
    row.setAttribute("aria-pressed", String(selected));
  });
}
function syncServerPorts(selected, items) {
  const remote = document.querySelector('.nav-item.active')?.dataset.tab === "skills";
  const id = remote ? (browsingServerId || selected) : null;
  const server = items.find(s => s.id === id);
  $("#wsPath").textContent = remote ? (server ? server.name + ' · 远程服务' : '选择服务器') : (S.treeData?.root || '');
  $("#wsPath").title = $("#wsPath").textContent;
  const next = server?.id || null;
  $("#wsTree").hidden = remote;
  $("#serverPorts").hidden = !remote;
  $("#btnNewFile").hidden = $("#btnNewDir").hidden = remote;
  $("#sideFilesTitle").textContent = next ? "监听端口 · " + server.name : remote ? "监听端口" : "文件";
  if (remote && !next) $("#serverPorts").innerHTML = '<div class="res-empty">选择服务器查看监听端口</div>';
  $("#treeRefresh").title = next ? "刷新服务器端口" : "刷新文件树";
  if (portServerId !== next) { portPreviewRequest++; portServerId = next; portRequest++; if (next) loadServerPorts(); }
}
async function loadServerPorts(force = false) {
  const id = portServerId; if (!id) return;
  const seq = ++portRequest, box = $("#serverPorts");
  box.innerHTML = '<div class="res-empty">正在读取监听端口…</div>';
  const cached = portCache.get(id);
  const result = !force && cached && Date.now()-cached.updated < 15000 ? { ok: true, data: cached } : await window.halo.serverPorts(id);
  if (seq !== portRequest || id !== portServerId) return;
  box.replaceChildren();
  if (!result.ok) { const error = document.createElement("div"); error.className = "res-empty"; error.textContent = result.error + "，点击刷新重试"; box.appendChild(error); return; }
  portCache.set(id, result.data);
  const meta = document.createElement("div"); meta.className = "port-meta"; meta.textContent = result.data.items.length + " 个监听项 · " + new Date(result.data.updated).toLocaleTimeString(); box.appendChild(meta);
  for (const item of result.data.items) {
    const row = document.createElement("div"); row.className = "port-row"; row.dataset.portKey = portKey(id, item);
    row.tabIndex = 0; row.setAttribute("role", "button"); row.title = "点击预览端口 " + item.port;
    const open = async () => {
      const request = ++portPreviewRequest;
      selectedPortKey = portKey(id, item); updatePortSelection();
      previewService = {kind:"service", serverId:id, port:item.port, protocol:item.protocol, address:item.address, process:item.process, status:"loading"};
      S.previewFile = null; $("#btnOpenFile").hidden = true; $("#pvMode").hidden = true;
      const serverLabel = document.querySelector('.server-group[data-server-id="' + CSS.escape(id) + '"] .server-group-toggle span')?.textContent || "服务器";
      $("#pvName").textContent = serverLabel + " · " + item.port;
      const body = $("#pvBody"); body.innerHTML = '<div class="pv-empty"><p>正在连接网页服务…</p></div>';
      const result = await window.halo.serverPreview(id, item);
      if (request !== portPreviewRequest || id !== portServerId) return;
      if (!result?.ok) { previewService.status = "failed"; body.innerHTML = '<div class="pv-empty"><p>' + esc(result?.error || "预览失败") + "</p></div>"; return; }
      body.innerHTML = '<div class="dev-shell"><div class="dev-screen"><webview title="服务器端口预览" partition="server-preview"></webview></div></div>';
      const guest = $("webview", body);
      guest.addEventListener("did-fail-load", event => {
        if (request === portPreviewRequest && event.isMainFrame && event.errorCode !== -3) {
          if (previewService) previewService.status = "failed";
          body.innerHTML = '<div class="pv-empty"><p>网页加载失败：' + esc(event.errorDescription || "请重新点击端口重试") + '</p></div>';
        }
      });
      previewService.url = result.data;
      guest.addEventListener("did-finish-load", () => { if (request === portPreviewRequest && previewService) previewService.status = "loaded"; });
      guest.src = result.data;
      updatePortSelection();
      window.halo.previewTouch?.(currentPreviewDevice() !== "desktop");
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    row.innerHTML = '<div><b></b><span></span></div><small></small><small></small>';
    $("b", row).textContent = item.port;
    $("span", row).textContent = item.protocol;
    const details = row.querySelectorAll("small"); details[0].textContent = item.process + (item.pid ? " · PID " + item.pid : ""); details[1].textContent = item.address;
    box.appendChild(row);
  }
  updatePortSelection();
  if (!result.data.items.length) box.appendChild(Object.assign(document.createElement("div"), { className: "res-empty", textContent: "暂无监听端口" }));
}

async function refreshServers() {
  const request = ++serverListRequest;
  const r = await window.halo.serverList();
  if (request !== serverListRequest || draggedServer) return;
  if (!r?.ok) { toast(r?.error || "服务器列表读取失败", "err"); return; }
  const { items, selected, conversations = [] } = r.data;
  syncServerPorts(selected, items);
  const list = $("#serverList"); list.replaceChildren();
  if (!items.length) list.innerHTML = '<div class="res-empty">添加服务器，通过 SSH 远程管理</div>';
  for (const server of items) {
    const group = document.createElement("div"); group.className = "server-group" + (server.connected ? " connected" : "");
    group.innerHTML = '<div class="server-group-head"><button class="server-group-toggle"><svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4M8 21h8"/></svg><span></span></button><details class="server-group-menu" name="server-actions"><summary title="服务器操作">···</summary><div><button class="server-group-connect">连接</button><button class="server-group-edit">编辑</button><button class="server-group-remove">删除服务器</button></div></details><button class="server-group-new" title="新建服务器对话"><svg viewBox="0 0 24 24" class="ic"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M14 5l5 5M10 14l1-5 7-7 5 5-7 7Z"/></svg></button></div><div class="server-conversations"></div>';
    group.dataset.serverId = server.id;
    const heading = $(".server-group-toggle", group); heading.draggable = true;
    heading.addEventListener("dragstart", e => { draggedServer = server.id; closeServerMenus(); e.dataTransfer.setData("text/plain", server.id); e.dataTransfer.effectAllowed = "move"; group.classList.add("dragging"); });
    heading.addEventListener("dragend", () => { draggedServer = null; $$(".server-group").forEach(g => g.classList.remove("dragging", "drop-before", "drop-after")); });
    group.addEventListener("dragover", e => {
      if (!draggedServer || draggedServer === server.id) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      $$(".server-group").forEach(g => g.classList.remove("drop-before", "drop-after"));
      group.classList.add(e.clientY < group.getBoundingClientRect().top + group.offsetHeight / 2 ? "drop-before" : "drop-after");
    });
    group.addEventListener("drop", async e => {
      if (!draggedServer || draggedServer === server.id) return;
      e.preventDefault();
      const ids = items.map(s => s.id).filter(id => id !== draggedServer);
      ids.splice(ids.indexOf(server.id) + (group.classList.contains("drop-after") ? 1 : 0), 0, draggedServer);
      draggedServer = null;
      const result = await window.halo.serverReorder(ids);
      if (!result.ok) toast(result.error, "err");
      await refreshServers();
    });
    $(".server-group-edit", group).addEventListener("click", () => openServerForm(server));
    $(".server-group-toggle span", group).textContent = server.name;
    const latency = document.createElement("button"); latency.className = "server-latency"; latency.setAttribute("aria-busy", "true");
    latency.title = "本机到服务器 SSH 端口的 TCP 连接耗时（含域名解析），点击重新测速，每分钟自动刷新";
    latency.type = "button";
    latency.setAttribute("aria-label", "重新测量 " + server.name + " 的延迟");
    latency.addEventListener("click", async () => {
      if (latencyPending.has(server.id)) return;
      latencyPending.add(server.id); latency.disabled = true; latency.textContent = ""; latency.setAttribute("aria-busy", "true");
      try {
        const result = await window.halo.serverLatency(server.id);
        if (!result?.ok) throw Error(result?.error || "测速失败");
        displayServerLatency(result.data);
      } catch (e) { latency.textContent = "重试"; toast(e.message, "err"); }
      finally { latencyPending.delete(server.id); latency.disabled = false; latency.removeAttribute("aria-busy"); }
    });
    $(".server-group-toggle", group).after(latency);
    const toggle = $(".server-group-toggle", group), children = $(".server-conversations", group);
    toggle.title = server.username + "@" + server.host + " · " + (server.connected ? "已连接" : "未连接");
    children.hidden = collapsedServers.has(server.id);
    addConversationFold(toggle, children, collapsedServers, server.id, server.name);
    toggle.addEventListener("click", () => { browsingServerId = server.id; syncServerPorts(selected, items); });
    $(".server-group-connect", group).addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      browsingServerId = server.id;
      const result = await window.halo.serverSelect(server.id);
      if (!result.ok) toast(result.error, "err");
      else { applyState(result.data); await restoreHistory(); await loadSessions(); }
      await refreshServers();
    });
    $(".server-group-remove", group).addEventListener("click", async () => {
      await removeWorkspaceItem(() => window.halo.serverRemove(server.id), server.id);
    });
    $(".server-group-new", group).addEventListener("click", async () => {
      if (S.switchingSession) return;
      S.switchingSession = true;
      try {
        const result = await window.halo.serverNewSession(server.id);
        if (!result.ok) throw Error(result.error);
        clearChat(); applyState(result.data); await restoreHistory();
        collapsedServers.delete(server.id); await refreshServers(); await loadSessions(); $("#input").focus();
      } catch (e) { toast(e.message, "err"); }
      finally { finishSessionSwitch(); }
    });
    const rows = conversations.filter(c => c.serverId === server.id);
    if (!rows.length) children.innerHTML = '<div class="server-conversation-empty">暂无对话，点击右上角新建</div>';
    for (const conversation of rows) {
      const button = document.createElement("button");
      button.className = "server-conversation" + (normPath(conversation.file) === normPath(S.state?.sessionFile) ? " active" : "");
      button.textContent = conversation.name;
      button.title = conversation.name;
      if (conversation.running) { const dot = document.createElement("i"); dot.className = "server-running-dot"; button.prepend(dot); }
      button.addEventListener("click", () => { browsingServerId = server.id; openSession(conversation.file); });
      const row = document.createElement("div"); row.className = "server-conversation-row";
      const remove = document.createElement("button"); remove.className = "server-conversation-delete";
      remove.title = "删除会话"; remove.setAttribute("aria-label", "删除会话 " + conversation.name);
      remove.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>';
      remove.addEventListener("click", () => requestDeleteSession(conversation, row, remove));
      row.append(button, remove); children.appendChild(row);
    }
    if (server.id === selected) group.classList.add("current");
    list.appendChild(group);
  }
  refreshServerLatencies();
}
const latencyPending = new Set();
function displayServerLatency(item) {
  const el = document.querySelector('.server-group[data-server-id="'+CSS.escape(item.id)+'"] .server-latency');
  if (!el || Number(el.dataset.checkedAt || 0) > item.checkedAt) return;
  el.removeAttribute("aria-busy");
  el.dataset.checkedAt = item.checkedAt;
  el.textContent = item.status === "ok" ? item.ms + " ms" : item.status === "timeout" ? "超时" : "不可达";
  el.dataset.quality = item.status !== "ok" ? "error" : item.ms < 100 ? "fast" : item.ms < 250 ? "normal" : "slow";
}
let latencyLoading = false;
async function refreshServerLatencies(force = false) {
  if (latencyLoading) return;
  latencyLoading = true;
  try {
    const r = await window.halo.serverLatencies(force);
    for (const item of r?.data || []) displayServerLatency(item);
  } finally { latencyLoading = false; }
}
function closeServerMenus() {
  $$(".server-group-menu[open]").forEach(menu => { menu.open = false; });
}
function updateServerAuthField() {
  const form = $("#serverForm"), key = form.elements.auth.value === "key";
  form.elements.secret.type = key ? "text" : "password";
  form.elements.secret.required = !form.dataset.serverId || form.elements.auth.value !== form.dataset.originalAuth;
  form.elements.secret.placeholder = form.elements.secret.required ? "" : "留空保留原凭据";
  $("#serverSecretLabel").textContent = key ? "私钥文件完整路径" : "密码";
}
function openServerForm(server = null) {
  const form = $("#serverForm"); form.reset();
  form.dataset.serverId = server?.id || ""; form.dataset.originalAuth = server?.auth || "password";
  if (server) for (const key of ["name", "host", "port", "username", "auth"]) form.elements[key].value = server[key];
  $("#serverModal h3").textContent = server ? "编辑服务器" : "添加服务器";
  $("#serverFormError").textContent = "";
  updateServerAuthField(); openModal("serverModal");
}
function initServerUI() {
  setInterval(() => refreshServerLatencies(true), 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshServerLatencies(); });
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".server-group-menu")) closeServerMenus(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $(".server-group-menu[open]")) {
      const trigger = $(".server-group-menu[open] summary");
      e.preventDefault(); e.stopImmediatePropagation(); closeServerMenus(); trigger?.focus();
    }
  }, true);
  $("#serverList").addEventListener("click", (e) => {
    if (e.target.closest(".server-group-menu button")) closeServerMenus();
  }, true);
  $("#serverAdd").addEventListener("click", () => openServerForm());
  const form = $("#serverForm");
  form.elements.auth.addEventListener("change", updateServerAuthField);
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
    try {
      const result = await window.halo.serverSave({ ...Object.fromEntries(new FormData(form)), id: form.dataset.serverId || undefined });
      if (!result.ok) { $("#serverFormError").textContent = result.error; return; }
      form.reset(); portCache.clear(); portServerId = null; closeModal($("#serverModal")); await refreshServers();
    } finally { button.disabled = false; }
  });
  document.addEventListener("projectstatechange", () => { if (S.state?.ready) void refreshServers(); });
  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener("click", refreshServers));
  $("#treeRefresh").addEventListener("click", (e) => { if (portServerId) { e.stopImmediatePropagation(); loadServerPorts(true); } }, true);
}

function applyState(st) {
  document.documentElement.dataset.projectCwd = st?.cwd || "";
  if (!st) return;
  S.state = st;
  document.dispatchEvent(new Event("projectstatechange"));
  if (st.sessionFile) saveWorkspace();
  if (st.cwd) {
    const name = st.cwd.split(/[\\/]/).filter(Boolean).pop() || st.cwd;
    $("#sessionProjectName").textContent = name;
    $("#sessionProjectName").title = st.cwd;
  }
  const m = st.model;
  $("#modelChipName").textContent = m ? m.name : "模型";
  $("#btnModel").title = m ? m.name : "选择模型";

  const tl = st.thinkingLevel || "off";

  $("#thinkChip").textContent = THINK_LABELS[tl] || tl;

  renderStats(st.usage);

  const ready = !!st.ready;
  $("#input").placeholder = ready
    ? "描述你要完成的任务…  Enter 发送 · Shift+Enter 换行"
    : "核心唤醒中，请稍候…";
  $("#btnSend").disabled = !ready;
  $("#btnSend").classList.toggle("dim", !ready);

  // 焦点会话是唯一真源。不能与旧的本地 streaming 状态取 OR，否则从运行中的
  // 会话切到空闲会话后仍会把“发送”误判成 steer，导致第二个会话无法启动。
  setStreamingUI(!!st.isStreaming);

  if (st.ready && S.pendingRestore) {
    S.pendingRestore = false;
    void restoreInitialWorkspace();
  }
}

/* 当前模型的剩余额度：切模型 / 每轮对话结束时刷新（force 跳过主进程防抖缓存） */
let quotaFetching = false;
let videoBalanceVersion = 0;
async function loadVideoBalance() {
  const el = $('#ctxVideoQuota');
  if (!el || !window.halo?.videoBalance) return;
  const version = ++videoBalanceVersion;
  el.textContent = '视频 查询中…';
  try {
    const reply = await window.halo.videoBalance({});
    if (version !== videoBalanceVersion) return;
    const value = reply?.ok ? reply.data : null;
    el.textContent = `视频 ${value?.provider_name || ''} ${videoBalanceText(value)}`;
    el.title = value ? `默认视频平台：${value.provider_name} · ${value.model}${value.enabled ? '' : '（已停用）'}，点击查看视频消耗记录`
      : reply?.error || '视频余额查询失败，点击查看消耗记录';
  } catch { if (version === videoBalanceVersion) el.textContent = '视频 查询失败'; }
}
async function loadQuota(provider, force = false) {
  if (!provider) return;
  if (S.quota.provider === provider && !force) return;
  if (!window.halo?.modelQuota) return;
  if (quotaFetching) return; // 已有请求在途：本轮结束时会再次刷新，无需并发
  quotaFetching = true;
  try {
    const r = await window.halo.modelQuota(provider, force).catch(() => null);
    if (!r?.ok) return;
    // 过程中模型又切了：丢弃过期结果
    if ((S.state?.model?.provider || null) !== provider) return;
    S.quota = { provider, data: r.data };
    renderQuotaChip();
  } finally {
    quotaFetching = false;
  }
}

function renderQuotaChip() {
  const el = $("#ctxQuota");
  if (!el) return;
  const provider = S.state?.model?.provider || null;
  const q = S.quota.provider === provider ? S.quota.data : null;
  const portals = { longcat: "https://longcat.chat/platform/usage?tab=token" };
  el.classList.remove("low", "kind-plain");
  el.dataset.portal = "";
  el.style.cursor = "default";
  if (q?.kind === "points" && !q.error) {
    // 积分制：纯数字，无上限不画条
    el.classList.add("kind-plain");
    $("#ctxQuotaBar").style.width = "100%";
    $("#ctxQuotaText").textContent = `${q.label} ${(q.value ?? 0).toLocaleString()}`;
    el.title = `${q.label}余额（AutoClaw 积分制，每轮对话后刷新）`;
    return;
  }
  if (q?.kind === "balance" && !q.error) {
    // 余额制：货币金额（DeepSeek / Moonshot / OpenRouter 等）
    el.classList.add("kind-plain");
    const sym = q.currency === "CNY" ? "¥" : q.currency === "USD" ? "$" : "";
    $("#ctxQuotaBar").style.width = "100%";
    $("#ctxQuotaText").textContent = `${sym}${(q.value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    el.title = `${q.label}（每轮对话后刷新）${q.voucher > 0 ? ` · 代金券 ${sym}${q.voucher.toLocaleString()}` : ""}`;
    return;
  }
  if (q?.kind === "windows" && Array.isArray(q.windows) && q.windows.length) {
    // 订阅制双窗口（OpenAI Codex：5h + 7d）：条显示最紧张的那个
    const parts = q.windows.map((w) => {
      const reset = w.resetAt ? new Date(w.resetAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      return { text: `${w.label} ${(w.remaining * 100).toFixed(0)}%`, remaining: w.remaining, title: `${w.label}窗 剩 ${(w.remaining * 100).toFixed(1)}%${reset ? ` · ${reset} 重置` : ""}` };
    });
    const tight = parts.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    $("#ctxQuotaBar").style.width = (tight.remaining * 100).toFixed(1) + "%";
    $("#ctxQuotaText").textContent = parts.map((p) => p.text).join(" · ");
    el.classList.toggle("low", tight.remaining < 0.15);
    el.title = `订阅额度 · ${parts.map((p) => p.title).join("，")}（每轮对话后刷新）`;
    return;
  }
  // 没有真实额度数据：一律不显示百分比，只提示
  const portal = portals[provider] || "";
  el.classList.add("kind-plain");
  $("#ctxQuotaBar").style.width = "0%";
  $("#ctxQuotaText").textContent = q?.error ? "额度 —" : "—";
  el.title = q?.error
    ? "该模型的额度接口暂不可用"
    : portal
      ? "该模型为 Token 资源包制（网页登录态鉴权，本地无法读取）· 点击打开官网用量页"
      : "该模型暂无额度接口";
  el.dataset.portal = portal;
  el.style.cursor = "pointer";
}

/** 账户芯片上的额度摘要：订阅制“5h 82% · 7d 41%”、余额制“$12.34”、积分制“1,234 分”；无接口返回空 */
function formatQuotaShort(q) {
  if (!q || q.kind === "context") return "";
  if (q.error) return "额度 —";
  if (q.kind === "windows" && Array.isArray(q.windows) && q.windows.length)
    return q.windows.map((w) => `${w.label} ${(w.remaining * 100).toFixed(0)}%`).join(" · ");
  if (q.kind === "balance") {
    const sym = q.currency === "CNY" ? "¥" : q.currency === "USD" ? "$" : "";
    return `${sym}${(q.value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  if (q.kind === "points") return `${(q.value ?? 0).toLocaleString()} 分`;
  return "";
}

function renderStats(u = {}) {
  const st = S.state || {};
  const ctx = st.contextTokens || 0;
  const win = st.model?.contextWindow || 0;
  // 剩余额度展示（替代原技能按钮）：积分制 / 订阅百分比 / 上下文兑底
  renderQuotaChip();
  // 模型（provider）变了就拉一次额度
  if (st.model?.provider && S.quota.provider !== st.model.provider) loadQuota(st.model.provider, true);
  const allZero = !u.input && !u.output && !u.cacheRead && !u.cacheWrite && !u.cost;
  if (allZero) {
    $("#chatStats").innerHTML = `<span title="当前网关未返回用量统计">— tokens</span>`;
    return;
  }
  const ctxPart = win
    ? `${fmtTokens(ctx)}/${fmtTokens(win)} · ${((ctx / win) * 100).toFixed(1)}%`
    : `${fmtTokens(ctx)}`;
  // CH = 缓存命中率：缓存读取占全部提示 tokens（输入+缓存读+缓存写）的比例
  const promptAll = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  const ch = promptAll > 0 ? ((u.cacheRead || 0) / promptAll * 100).toFixed(1) + "%" : "—";
  // 用户要求：去掉 W（缓存写入）、费用，上下文不写字
  $("#chatStats").innerHTML =
    `<span title="输入 tokens（累计）">↑ ${fmtTokens(u.input)}</span>` +
    `<span title="输出 tokens（累计）">↓ ${fmtTokens(u.output)}</span>` +
    `<span title="缓存读取（累计）">R ${fmtTokens(u.cacheRead)}</span>` +
    `<span title="缓存命中率（缓存读取 / 全部提示 tokens）">CH ${ch}</span>` +
    `<span title="上下文占用（当前会话 / 模型窗口）">${esc(ctxPart)}</span>`;
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
  if (v) startStatusTicker();
  else stopStatusTicker();
  updateTurnStatus();
}

/* stall watchdog 已移除：工具执行/长思考静默属正常现象，不再显示停滞提示；
 * 回合状态行（turn-status）已实时反映“正在思考 / 正在执行 X”。 */

/* ============================================================
   pi event stream -> UI
   ============================================================ */
function wirePi() {
  // lightweight diagnostics: real-link event tracing (visible via CDP)
  window.__piDebug = { count: 0, types: [], ignored: 0 };
  window.halo.onPiEvent(({ sessionId, serverId, event, seq }) => {
    try {
      window.__piDebug.count++;
      window.__piDebug.types.push(event?.type);
      if (window.__piDebug.types.length > 200) window.__piDebug.types.shift();
    } catch {}
    refreshCompletedPreview({event, sessionId, serverId});
    handlePiEvent(event, sessionId, seq);
  });
  // debug/test hook: inject synthetic events without the main process
  window.__haloDispatch = (event, sessionId, seq) => handlePiEvent(event, sessionId, seq);
  window.__haloRestoreView = async (view) => {
    ++S.sessionSwitchSeq;
    S.switchingSession = true;
    clearChat();
    await restoreHistory(view);
    finishSessionSwitch();
  };
  window.__renderUserMsg = renderUserMsg;
  window.__mdRender = mdRender; // 调试/验证钩子
  window.halo.onState((st) => applyState(st));
  window.halo.onError?.((e) => toast(e?.message || "发生错误", "err"));
  window.halo.onWinState?.(({ maximized }) => {
    $("#winMax").title = maximized ? "还原" : "最大化";
    $("#winMax").classList.toggle("maxed", maximized);
  });
  // 项目内文件变化（含外部编辑器修改）→ 防抖刷新文件树
  window.halo.onTreeChanged?.(() => scheduleTreeRefresh());
}

/* 后台会话事件刷新：仅更新左侧会话列表的运行徽标，不打扰当前视图 */
const refreshSessionsDebounced = debounce(() => { try { loadSessions(); refreshServers(); } catch {} }, 400);

let pendingSessionEvents = [];
let restoredEventSeq = 0;
function handlePiEvent(event, sessionId, seq) {
  if (!event) return;
  if (S.switchingSession) {
    pendingSessionEvents.push({ event, sessionId, seq });
    refreshSessionsDebounced();
    return;
  }
  // 多会话并发：只渲染焦点会话的事件；其他会话事件仅刷新列表运行状态
  if (sessionId && S.state?.sessionId && sessionId !== S.state.sessionId) {
    window.__piDebug.ignored++;
    refreshSessionsDebounced();
    return;
  }
  if (seq && seq <= restoredEventSeq) return;
  // 焦点/后台会话的生命周期变化 → 刷新左侧运行徽标（message_start 时新会话落盘进列表）
  if (event.type === "agent_start" || event.type === "message_start" || event.type === "message_end" || event.type === "agent_end" || event.type === "agent_settled") {
    refreshSessionsDebounced();
  }
  switch (event.type) {
      case "extension_notice": {
        const note = document.createElement("div");
        note.className = "extension-notice";
        const label = document.createElement("div");
        label.className = "extension-notice-label";
        label.textContent = event.level === "error" ? "指令错误" : "扩展通知";
        const pre = document.createElement("pre");
        pre.textContent = String(event.message || "").replace(/\x1b\[[0-9;]*m/g, "");
        note.append(label, pre);
        $("#messages").appendChild(note);
        scrollDown(true);
        break;
      }
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
        // 每轮对话结束：立即刷新额度（不再依赖定时轮询）
        loadQuota(S.state?.model?.provider, true);
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
  wrap.__startedAt = Date.now();
  wrap.__toolCount = 0;
  wrap.innerHTML = `
    <div class="turn-status" hidden>
      <span class="pi-orb" aria-hidden="true"><svg viewBox="0 0 24 24"><circle class="orbit-track" cx="12" cy="12" r="9"/><g class="orbit-outer"><path d="M12 3a9 9 0 0 1 9 9"/><circle cx="21" cy="12" r="1.5"/></g><g class="orbit-inner"><path d="M12 7a5 5 0 0 1 0 10"/></g><circle class="orbit-core" cx="12" cy="12" r="1.5"/></svg></span>
      <span class="turn-status-copy">
        <b class="turn-status-text">正在思考…</b>
        <span class="turn-status-meta">刚刚开始</span>
      </span>

    </div>`;
  $("#messages").appendChild(wrap);
  S.turn = wrap;
  scrollDown();
  return wrap;
}

// Keep only the latest tool step in the live timeline.
function compactToolTimeline(turn) {
  const tools = Array.from(turn.children).filter(node => node.classList.contains('tool'));
  if (tools.length <= 1) return;
  let archive = turn.querySelector(':scope > .tool-history');
  if (!archive) {
    archive = document.createElement('details');
    archive.className = 'process-group tool-history';
    archive.innerHTML = '<summary title="展开或收起较早的执行过程"><svg class="process-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></summary><div class="process-body"></div>';
    turn.insertBefore(archive, turn.firstChild);
  }
  const body = archive.querySelector('.process-body');
  const cutoff = tools[tools.length - 1];
  for (const node of Array.from(turn.children)) {
    if (node === cutoff) break;
    if (node.matches('.tool, .think, .md, .stall-hint')) body.appendChild(node);
  }
  const status = turn.querySelector('.turn-status');
  if (status) archive.querySelector('summary').prepend(status);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const secs = total % 60;
  return [hours ? hours + '小时' : '', minutes ? minutes + '分钟' : '', secs || !total ? secs + '秒' : ''].filter(Boolean).join(' ');
}

function updateVideoArtifactCard(button, file, turn, cwd) {
  if (!button?.classList.contains('artifact-video')) return;
  const result = [...(turn.__videoResults?.values() || [])].find(item => {
    const recorded = artifactPath(item.file, cwd);
    return recorded && normPath(recorded) === normPath(file);
  });
  if (!result) return;
  const meta = button.querySelector('.artifact-meta');
  meta.classList.add('artifact-video-details');
  let model = meta.querySelector('.artifact-video-model');
  if (!model) {
    model = document.createElement('span'); model.className = 'artifact-video-model';
    const metrics = document.createElement('span'); metrics.className = 'artifact-video-metrics';
    meta.replaceChildren(model, metrics);
  }
  model.textContent = `${result.provider_name || result.provider} · ${result.model}`;
  const duration = result.timing?.totalMs;
  const validDuration = value => Number.isFinite(value) && value >= 0;
  const time = validDuration(duration) ? `生成用时 ${formatDuration(duration / 1000)}`
    : validDuration(result.__toolDurationMs) ? `工具用时 ${formatDuration(result.__toolDurationMs / 1000)}` : '生成用时未记录';
  const usage = result.usage;
  const amountText = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6, useGrouping: false }).format(value);
  const unitText = unit => unit === 'Credits' ? '积分' : unit || '';
  const cost = usage && Number.isFinite(usage.amount) && usage.amount >= 0
    ? `实际消耗 ${amountText(usage.amount)} ${unitText(usage.unit)}`
    : '平台未返回实际消耗';
  meta.querySelector('.artifact-video-metrics').textContent = `${time} · ${cost}`;
  const stages = [['platformMs', '平台耗时'], ['submissionMs', '提交'], ['generationMs', '生成及查询'], ['downloadMs', '下载']]
    .filter(([key]) => validDuration(result.timing?.[key]))
    .map(([key, label]) => `${label} ${formatDuration(result.timing[key] / 1000)}`);
  const source = { credits_cost: '平台结算积分', cost_usd_x10: '平台结算金额换算（1 美元 = 10 积分）' }[result.billing?.platform?.source];
  const estimate = result.billing?.estimate;
  let billingText = '';
  if (estimate?.available && Number.isFinite(estimate.total) && estimate.total >= 0) {
    billingText = `预估 ${amountText(estimate.total)} ${unitText(estimate.currency)}`;
    if (usage?.unit === estimate.currency && Number.isFinite(usage.amount) && usage.amount >= 0) {
      const delta = Number.isFinite(result.billing.delta) ? result.billing.delta : usage.amount - estimate.total;
      billingText += ` · 实际 ${amountText(usage.amount)} ${unitText(usage.unit)} · 差额 ${delta > 0 ? '+' : ''}${amountText(delta)} ${unitText(usage.unit)}`;
    }
  }
  button.title = [file, `任务 ID：${result.task_id}`, stages.join(' · '),
    source ? `计费来源：${source}` : '', billingText].filter(Boolean).join('\n');
  button.setAttribute('aria-label', `预览视频：${file.split(/[\\/]/).pop()}，${model.textContent}，${time}，${cost}`);
}

async function showTurnArtifacts(turn) {
  renderWebsiteCards(turn, openWebsite);
  const request = turn.__artifactRequest = (turn.__artifactRequest || 0) + 1;
  const switchSeq = S.sessionSwitchSeq;
  const cwd = S.state?.cwd || '';
  let paths = replyArtifacts(turn.__texts?.at(-1) || '', cwd);
  for (const file of turn.__artifactFiles || []) {
    const p = artifactPath(file, cwd);
    if (p && !paths.some(x => normPath(x) === normPath(p))) paths.push(p);
  }
  if (!paths.length) { turn.querySelector(':scope > .turn-artifacts')?.remove(); return; }
  // Resolve delivery paths after renames; never advertise vanished intermediate files.
  const checked=await window.halo.artifactFiles(paths.slice(0,100)).catch(()=>null);
  if (!turn.isConnected || request !== turn.__artifactRequest || switchSeq !== S.sessionSwitchSeq ||
      cwd !== (S.state?.cwd || '') || !checked?.ok) return;
  paths = [...new Map(checked.data.map(file => [normPath(file), file])).values()];
  let box = turn.querySelector(':scope > .turn-artifacts');
  if (!paths.length) { box?.remove(); return; }
  box ||= document.createElement('div');
  box.className = 'turn-artifacts';
  box.setAttribute('aria-label','生成文件');
  // Reconcile deliveries in place: final text and repeated status results must
  // neither duplicate a file card nor reload its thumbnail.
  const existing = new Map(Array.from(box.children, node => [node.dataset.artifactPath, node]));
  const wanted = new Set(paths.map(normPath));
  for (const [key, node] of existing) if (!wanted.has(key)) node.remove();
  let index = 0;
  for (const file of paths) {
    const key = normPath(file);
    const previous = existing.get(key);
    if (previous) {
      updateVideoArtifactCard(previous.querySelector('.artifact-video'), file, turn, cwd);
      if (box.children[index] !== previous) box.insertBefore(previous, box.children[index] || null);
      index++;
      continue;
    }
    const button=document.createElement('button');
    decorateArtifactCard(button, file, previewURL(file));
    updateVideoArtifactCard(button, file, turn, cwd);
    button.onclick=async()=>{
      document.body.classList.remove('preview-collapsed','focus-mode');
      syncPreviewMotion();
      $('#center').inert=false;
      document.querySelector('.term-open')?.classList.remove('term-open');
      $('#btnTerm')?.classList.remove('active');
      const toggle=$('#btnPreviewToggle');toggle.setAttribute('aria-expanded','true');toggle.title='收起预览区';toggle.setAttribute('aria-label',toggle.title);
      try { await setPreview(file,true); saveWorkspace(); } catch(error){toast(error.message,'err');}
    };
    let entry = button;
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(file)) {
      const row=document.createElement('div');row.className='artifact-image-row';
      const copy=document.createElement('button');copy.className='artifact-copy-button';copy.type='button';
      copy.title='复制图片';copy.setAttribute('aria-label','复制图片');
      copy.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>';
      copy.onclick=async()=>{
        copy.disabled=true;
        try {const r=await window.halo.copyImage(file);if(!r?.ok)throw Error(r?.error || '复制失败');toast('图片已复制','ok');}
        catch(error){toast(error.message,'err');}
        finally{copy.disabled=false;}
      };
      row.append(button,copy);entry = row;
    } else if (/\.(mp4|webm)$/i.test(file)) {
      const row = document.createElement('div'); row.className = 'artifact-video-row';
      row.append(button); entry = row;
    }
    entry.dataset.artifactPath = key;
    box.insertBefore(entry, box.children[index++] || null);
  }
  if (!box.isConnected) turn.appendChild(box);
  // The file card is the preview entry; avoid repeating the same image at full size.
  for (const img of turn.querySelectorAll('.md img')) {
    const file = artifactPath(img.getAttribute('src'), cwd);
    if (!file || !paths.some(p => normPath(p) === normPath(file))) continue;
    const paragraph = img.closest('p');
    img.remove();
    if (paragraph && !paragraph.textContent.trim() && !paragraph.querySelector('img, a, code')) paragraph.remove();
  }
  scrollDown();
}
function collectArtifactResult(turn, toolName, text, toolDurationMs) {
  if (!turn || !['image_generate','video_generate','office_document','cloudflare_deploy'].includes(toolName)) return;
  try {
    const result=JSON.parse(text);
    if (toolName === 'cloudflare_deploy') {
      if (result.deployed && Array.isArray(result.urls)) {
        const urls = (turn.__websiteURLs ||= new Set());
        result.urls.forEach(url => { if (websiteURL(url)) urls.add(websiteURL(url)); });
      }
      return;
    }
    if (toolName === 'video_generate' && result.task_id && result.model) {
      const records = (turn.__videoResults ||= new Map());
      const key = `${result.provider}:${result.task_id}`;
      const previous = records.get(key);
      records.set(key, { ...previous, ...result, file: result.file || previous?.file,
        usage: result.usage || previous?.usage, timing: result.timing || previous?.timing,
        __toolDurationMs: previous?.__toolDurationMs ?? toolDurationMs });
    }
    const files=['image_generate','video_generate'].includes(toolName)?[result.file]:(result.files || []);
    if(Array.isArray(files)) (turn.__artifactFiles ||= []).push(...files.filter(f=>typeof f==='string'));
  } catch {}
}

function finalizeTurn() {
  const turn = S.turn;
  S.turn = null;
  if (!turn) return;
  collapseThink();
  $$(".think[open]", turn).forEach((d) => { d.open = false; });
  $(".turn-status", turn)?.remove();
  // Flatten the live archive before collecting the final collapsed process.
  const archive = turn.querySelector(':scope > .tool-history');
  if (archive) {
    for (const node of Array.from(archive.querySelector('.process-body').children)) turn.insertBefore(node, archive);
    archive.remove();
  }
  // 只把最后一段正文视为最终回答；此前的阶段性说明与思考、工具一起收进过程。
  const finalAnswer = $$(".md", turn).at(-1) || null;
  const processNodes = $$(".think, .tool, .stall-hint, .md", turn).filter((node) => node !== finalAnswer);
  if (processNodes.length) {
    const elapsed = turn.__history
      ? (turn.__startedAt > 0 && turn.__endedAt > turn.__startedAt ? Math.max(1, Math.round((turn.__endedAt - turn.__startedAt) / 1000)) : null)
      : Math.max(1, Math.round((Date.now() - (turn.__startedAt || Date.now())) / 1000));
    const durationLabel = elapsed == null ? '执行过程' : (turn.__estimated ? '约用时 ' : '用时 ') +
      formatDuration(elapsed);
    const errors = $$(".tool.error", turn).length;
    const group = document.createElement("details");
    group.className = "process-group";
    group.innerHTML = `
      <summary title="展开执行过程 · ${processNodes.length} 个步骤${errors ? ` · ${errors} 个失败` : ""}">
        <span class="process-label">${durationLabel}</span>
        <svg class="process-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
      </summary>
      <div class="process-body"></div>`;
    processNodes[0].parentNode.insertBefore(group, processNodes[0]);
    const body = $(".process-body", group);
    for (const node of processNodes) body.appendChild(node);
  }
  // 最终答案保持展开，点击用时可查看完整执行过程。
  turn.classList.add("complete");
  showTurnArtifacts(turn);
  if (!$(".md, .think, .tool, .error-card, .stall-hint", turn)) turn.remove();
}

/* 回合内等待状态：π 动画图标 + 当前动作 + Esc 提示（行首，替代文末光标） */
let _statusTimer = null;
function turnStatusText() {
  if (S.retrying) return `自动重试中 (${S.retrying.attempt}/${S.retrying.maxAttempts})`;
  if (S.streamingTool === 'video_generate') {
    const rec = [...S.toolCards.values()].reverse().find(item => item.toolName === 'video_generate' && item.card.classList.contains('running'));
    if (rec?.videoProgress) return rec.videoProgress;
  }
  if (S.streamingTool) return `正在执行 ${S.streamingTool}`;
  if (S.assistant) return "正在回复…";
  if (S.streaming) return "正在思考…";
  return "";
}
function updateTurnStatus() {
  const turn = S.turn;
  const row = turn && $(".turn-status", turn);
  if (!row) return;
  const txt = turnStatusText();
  row.hidden = !txt;
  if (!txt) return;
  $(".turn-status-text", row).textContent = txt;
  const elapsed = Math.max(0, Math.round((Date.now() - (turn.__startedAt || Date.now())) / 1000));
  const toolCount = turn.__toolCount || 0;
  $(".turn-status-meta", row).textContent =
    `${elapsed < 2 ? "刚刚开始" : `已运行 ${formatDuration(elapsed)}`}${toolCount ? ` · ${toolCount} 个工具` : ""}`;
  const summary = turn.querySelector(":scope > .tool-history > summary");
  const parent = summary || turn;
  if (row.parentElement !== parent || parent.firstElementChild !== row) parent.prepend(row);
  scrollDown();
}
function startStatusTicker() {
  if (_statusTimer) return;
  _statusTimer = setInterval(updateTurnStatus, 500);
}
function stopStatusTicker() {
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
}

/* 思考过程：流式展开；阶段结束后保留为一行自然语言步骤，点击可看全文。 */
function ensureThink() {
  if (S.thinking) return S.thinking;
  const d = document.createElement("details");
  d.className = "think";
  d.innerHTML = `<summary><span class="diamond">◆</span><span class="think-preview">正在分析下一步…</span><span class="think-label">思考中</span></summary><div class="think-body"></div>`;
  ensureTurn().appendChild(d);
  updateTurnStatus();
  d.open = true;
  S.thinking = { el: d, body: $(".think-body", d), label: $(".think-label", d), preview: $(".think-preview", d), buf: "", t0: Date.now() };
  return S.thinking;
}

const thinkPreviewText = (buf) =>
  String(buf).replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 96);

function collapseThink() {
  const t = S.thinking;
  if (!t) return;
  if (t.frame) { cancelAnimationFrame(t.frame); t.frame = 0; streamRender(t.body, t.buf); }
  const secs = Math.max(1, Math.round((Date.now() - t.t0) / 1000));
  t.label.textContent = `${secs}s`;
  t.preview.textContent = thinkPreviewText(t.buf) || "完成阶段分析";
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
  updateTurnStatus();
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
  updateTurnStatus();
  S.assistantText = "";
}

function onMessageStart(msg) {
  if (msg?.role === "user") {
    const { text, images } = userMessageParts(msg);
    if (!text.trim() && !images.length) return;
    finalizeMessage();
    finalizeTurn();
    renderUserMsg(text, images);
    S.lastUserPrompt = { text: userMessageText(text), images };
    if (S.streaming) ensureTurn();
    return;
  }
  if (!msg || msg.role !== "assistant") return;
  S.assistantText = "";
  S.thinkStreamed = false; // 本条消息是否流式收到过思考 delta（防止单尾重复恢复）
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
    S.thinkStreamed = true;
    const t = ensureThink();
    t.buf += ev.delta || "";
    if (!t.frame) t.frame = requestAnimationFrame(() => {
      t.frame = 0;
      if (S.thinking !== t) return;
      streamRender(t.body, t.buf);
      t.preview.textContent = thinkPreviewText(t.buf);
      t.body.scrollTop = t.body.scrollHeight;
      scrollDown();
    });
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
  // 注意：不能用 !S.thinking 判断 —— 正文开始时思考块已折叠、S.thinking 已置 null，
  // 但 DOM 里还在；再用 !S.thinkStreamed 区分“真没流式发过”和“发过但已折叠”，否则会重复
  if (!S.thinkStreamed && !S.thinking && Array.isArray(msg.content)) {
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
  // 增量流式渲染：已冻结段落不重渲，只有尾部随 delta 更新（长回复 O(n) 而非 O(n²)）
  streamRender(el, S.assistantText);
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
  if (mb) mb.addEventListener("click", () => openModal("modelModal"));
  (S.turn || $("#messages")).appendChild(n);
  scrollDown();
}

function renderFatalError(raw) {
  renderModelError(raw, {});
}

async function retryLast() {
  if (S.switchingSession) return toast("正在切换会话，请稍候再发送", "");
  if (!S.lastUserPrompt) return toast("没有可重试的消息", "err");
  if (S.streaming) return toast("任务进行中", "err");
  const { text, images } = S.lastUserPrompt;
  try {
    const result = await window.halo.prompt(text, { preview: currentPreviewContext(), ...(images.length ? { images: images.map(toPiImage) } : {}) });
    if (result?.ok === false) throw new Error(result.error || "指令执行失败");
  } catch (e) { toast(`发送失败：${e?.message || e}`, "err"); }
}

/* ---- tool timeline ---- */
const TOOL_LABELS = {
  read: "读取", write: "写入", edit: "编辑", grep: "搜索", glob: "查找",
  find: "查找", ls: "浏览", bash: "运行", powershell: "运行",
  web_search: "联网搜索", browser: "浏览器", task: "委派",
};
const AUTO_OPEN_TOOLS = new Set(["grep", "glob", "find"]);
const toolLabel = (name) => TOOL_LABELS[name] || name;
function toolDesc(toolName, args = {}) {
  const a = args || {};
  switch (toolName) {
    case "read": case "write": case "edit": return a.path || "";
    case "bash": case "powershell": return a.command || a.cmd || "";
    case "grep": return `${a.pattern || ""}${a.path ? "  ·  " + a.path : ""}`;
    case "glob": case "find": return a.pattern || a.path || "";
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
  const turn = ensureTurn();
  turn.__toolCount = (turn.__toolCount || 0) + 1;
  updateTurnStatus();

  // 时间线工具步骤：动作 + 目标；输出按需展开，搜索类结果默认展示。
  const card = document.createElement("div");
  card.className = "tool running";
  card.innerHTML = `
    <div class="tool-line" title="${esc(toolName)}">
      <span class="tool-dot"></span>
      <span class="tool-name">${esc(toolLabel(toolName))}</span>
      <span class="tool-arg">${esc(trunc(toolDesc(toolName, args), TRUNC_TOOL_ARG))}</span>
      <span class="tool-elapsed"></span>
      <svg class="tool-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
    </div>
    <div class="tool-out" hidden></div>`;
  $(".tool-line", card).addEventListener("click", () => {
    const out = $(".tool-out", card);
    if (out.dataset.has) out.hidden = !out.hidden;
  });
  turn.appendChild(card);
  compactToolTimeline(turn);
  updateTurnStatus();
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
  if (rec.toolName === 'video_generate') {
    const partial = ev.partialResult || ev.partial || ev.result;
    const details = partial?.details;
    if (details?.model && details?.provider) {
      const status = { preparing: '提交中', queued: '排队中', running: '正在生成', succeeded: '正在下载', failed: '生成失败', cancelled: '已取消' }[details.status] || '正在生成';
      rec.videoProgress = `${details.provider_name || details.provider} · ${details.model} · ${status}`;
      rec.arg.textContent = rec.videoProgress;
      updateTurnStatus();
      return;
    }
  }
  const args = ev.partial?.args || ev.args;
  if (args) rec.arg.textContent = trunc(toolDesc(rec.toolName, args), TRUNC_TOOL_ARG);
}

function onToolEnd(ev) {
  const { toolCallId, isError, result } = ev;
  const rec = S.toolCards.get(toolCallId);
  S.streamingTool = null;
  setStreamingUI(true);

  if (!rec) return;
  // elapsed + 状态点
  const secs = (Date.now() - rec.startedAt) / 1000;
  rec.elapsedEl.textContent = secs >= 0.5 ? (secs < 60 ? `${secs.toFixed(1)}秒` : formatDuration(secs)) : "";
  rec.card.classList.remove("running");
  rec.card.classList.add(isError ? "error" : "done");

  let text = "";
  const contents = result?.content || [];
  for (const c of contents) if (c.type === "text") text += (text ? "\n" : "") + c.text;
  const turn = rec.card.closest('.turn');
  if (!isError) {
    collectArtifactResult(turn, rec.toolName, text, secs * 1000);
    // The completed file is deliverable now, even if the assistant continues
    // thinking or running unrelated tools before its final response.
    if (turn?.isConnected && rec.toolName === 'video_generate') {
      showTurnArtifacts(turn);
      void loadVideoBalance();
      scheduleTreeRefresh();
    }
  }
  const diff = result?.details?.diff || result?.details?.patch;
  if (diff && !text) text = diff;

  // workspace: record session changes + refresh tree + auto-preview pages
  if (!isError && (rec.toolName === "write" || rec.toolName === "edit") && rec.path) {
    recordActivity({ path: rec.path, tool: rec.toolName, time: Date.now(), diff: diff ? String(diff).slice(0, 120000) : null });
    scheduleTreeRefresh();
    const ext = rec.path.split(".").pop().toLowerCase();
    if (ext === "html" || ext === "htm") {
      setPreview(rec.path, true);
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
  if (!isError && AUTO_OPEN_TOOLS.has(rec.toolName) && text.trim()) out.hidden = false;
  scrollDown();
}

/* ---- queue ---- */

function renderQueue() {
  const row = $("#queueRow");
  const items = [
    ...S.queued.steering.map((t) => ({ t, k: "引导" })),
    ...S.queued.followUp.map((t) => ({ t, k: "追加" })),
  ];
  row.hidden = items.length === 0;
  row.setAttribute("aria-label", `等待消息，共 ${items.length} 条`);
  row.innerHTML = items.map((i) =>
    `<details class="queue-chip">
      <summary title="点击展开完整消息">
        <svg class="queue-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 4v8a2 2 0 0 0 2 2h8m-3-3 3 3-3 3M9 5h6M9 8h4"/></svg>
        <span class="queue-text">${esc(i.t)}</span>
        <small>${i.k === "引导" ? "调整方向" : "等待执行"}</small>
        <svg class="queue-expand" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
      </summary>
      <div class="queue-detail">${esc(i.t)}</div>
    </details>`).join("");
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

let mentionItems = [], mentionIndex = 0, mentionStart = 0;
function closeMentions() {
  $("#mentionMenu").hidden = true;
  $("#input").setAttribute("aria-expanded", "false");
  $("#input").removeAttribute("aria-activedescendant");
}
function updateMentions() {
  const input = $("#input"), before = input.value.slice(0, input.selectionStart);
  if (/^\/[^\s]*$/.test(before) && input.selectionStart === input.selectionEnd) return updateCommandSuggestions(before.slice(1));
  const match = before.match(/(?:^|\s)@([^@\n]*)$/);
  if (!match || input.selectionStart !== input.selectionEnd) return closeMentions();
  mentionStart = before.length - match[1].length - 1;
  const query = match[1].toLowerCase();
  const cwd = S.state?.cwd || "";
  const all = cwd ? [{ name: cwd.split(/[\\/]/).filter(Boolean).pop(), path: cwd, dir: true, root: true }] : [];
  const walk = (nodes) => { for (const node of nodes || []) { all.push(node); if (node.children) walk(node.children); } };
  walk(S.treeData?.tree);
  mentionItems = all.filter((n) => (n.name + " " + n.path).toLowerCase().includes(query)).slice(0, 40);
  mentionIndex = 0;
  $(".mention-heading").textContent = "文件与文件夹 · " + (all[0]?.name || "当前项目");
  const options = $("#mentionOptions"); options.replaceChildren();
  for (const [i, item] of mentionItems.entries()) {
    const button = document.createElement("button");
    button.type = "button"; button.id = "mention-option-" + i;
    button.className = "mention-option"; button.setAttribute("role", "option");
    button.innerHTML = (item.dir ? FOLDER_IC : fileIconFor(item.name)) + '<span><b></b><small></small></span>';
    $("b", button).textContent = item.root ? "当前项目 · " + item.name : item.name;
    $("small", button).textContent = item.path;
    button.title = item.path;
    button.addEventListener("pointerdown", (e) => e.preventDefault());
    button.addEventListener("click", () => insertMention(i));
    options.appendChild(button);
  }
  if (!mentionItems.length) options.innerHTML = '<div class="mention-empty">未找到匹配的文件或文件夹</div>';
  $("#mentionMenu").hidden = false;
  input.setAttribute("aria-controls", "mentionOptions"); input.setAttribute("aria-expanded", "true");
  highlightMention();
}
function updateCommandSuggestions(query) {
  const builtins = [['new','新建会话'],['model','选择模型'],['thinking','设置思考强度'],['compact','压缩当前上下文'],['help','查看帮助']].map(([name,description]) => ({name,description}));
  const commands = [...builtins, ...(S.resources.commands || []), ...(S.resources.prompts || []), ...(S.resources.skills || []).map(s => ({...s,name:'skill:' + s.name}))];
  const unique = new Map();
  for (const c of commands) if (c.name && !unique.has(c.name)) unique.set(c.name,c);
  mentionItems = [...unique.values()].filter(c => c.name.toLowerCase().includes(query.toLowerCase())).map(c => ({...c,command:true}));
  mentionIndex = 0;
  $('.mention-heading').textContent = '系统与插件指令';
  const options = $('#mentionOptions'); options.replaceChildren();
  for (const [i,c] of mentionItems.entries()) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'mention-option'; button.id = 'mention-option-' + i;
    button.setAttribute('role','option');
    button.innerHTML = '<span><b></b><small></small></span>';
    $('b',button).textContent = '/' + c.name;
    $('small',button).textContent = c.description || '指令';
    button.addEventListener('pointerdown',e => e.preventDefault());
    button.addEventListener('click',() => insertMention(i));
    options.append(button);
  }
  if (!mentionItems.length) { closeMentions(); return; }
  $('#mentionMenu').hidden = false;
  $('#input').setAttribute('aria-controls','mentionOptions');
  $('#input').setAttribute('aria-expanded','true');
  highlightMention();
}
function highlightMention() {
  $$(".mention-option").forEach((b, i) => { b.classList.toggle("active", i === mentionIndex); b.setAttribute("aria-selected", String(i === mentionIndex)); });
  const option = $("#mention-option-" + mentionIndex);
  if (option) { $("#input").setAttribute("aria-activedescendant", option.id); option.scrollIntoView({ block: "nearest" }); }
}
function insertMention(index) {
  const item = mentionItems[index]; if (!item) return;
  const input = $("#input");
  if (item.command) {
    input.setRangeText('/' + item.name + ' ', 0, input.selectionStart, 'end');
    closeMentions(); autoGrow(); input.focus(); return;
  }
  const path = item.path.replace(/\\/g, "/");
  input.setRangeText('@"' + path + '" ', mentionStart, input.selectionStart, "end");
  closeMentions(); autoGrow(); input.focus();
}
function handleMentionKey(e) {
  if ($("#mentionMenu").hidden || e.isComposing) return false;
  if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) return false;
  e.preventDefault(); e.stopPropagation();
  if (e.key === "Escape") closeMentions();
  else if (e.key === "Enter" || e.key === "Tab") insertMention(mentionIndex);
  else if (mentionItems.length) { mentionIndex = (mentionIndex + (e.key === "ArrowUp" ? -1 : 1) + mentionItems.length) % mentionItems.length; highlightMention(); }
  return true;
}

async function send(queueMode = "steer") {
  const input = $("#input");
  const text = input.value.trim();
  if (!text && S.images.length === 0) return;
  if (S.switchingSession) return toast("正在切换会话，请稍候再发送", "");

  const queued = S.streaming;
  if (queued) {
    if (text.startsWith("/")) return toast("任务进行中，命令暂不可用", "err");
    if (S.images.length) return toast("图片附件请在当前任务结束后发送，草稿已保留", "");
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

  // Accepted user messages are rendered only by message_start, including queued
  // messages. Do not deduplicate by text: identical consecutive prompts are valid.
  const focus = { seq: S.sessionSwitchSeq, sessionId: S.state.sessionId, cwd: S.state.cwd };
  const sentImages = S.images.slice();
  S.images = [];
  renderAttachments();
  input.value = "";
  autoGrow();
  const clearedRevision = S.composerRevision;

  try {
    const result = queued
      ? await window.halo[queueMode === "followUp" ? "followUp" : "steer"](text)
      : await window.halo.prompt(text, { preview: currentPreviewContext(), ...(sentImages.length ? { images: sentImages.map(toPiImage) } : {}) });
    if (result?.ok === false) throw new Error(result.error || "指令执行失败");
  } catch (e) {
    toast(`发送失败：${e?.message || e}`, "err");
    // Restore only the untouched draft in the original view. State events remain
    // authoritative for running tasks, including a task started in another view.
    if (!S.switchingSession && focus.seq === S.sessionSwitchSeq && focus.sessionId === S.state?.sessionId &&
        focus.cwd === S.state?.cwd && clearedRevision === S.composerRevision && !input.value && !S.images.length) {
      input.value = text;
      S.images = sentImages;
      renderAttachments();
      autoGrow();
    }
  }
}

function renderUserMsg(text, images) {
  text = userMessageText(text);
  // 对话开始后清掉遗留的系统提示，保持对话流只包含当前对话内容
  $$("#messages > .notice").forEach((n) => n.remove());
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const imgs = (images || []).map((i) =>
    `<img src="data:${i.mediaType};base64,${i.data}" title="${esc(i.name)}" />`).join("");
  wrap.innerHTML = `
    ${imgs ? `<div class="imgs">${imgs}</div>` : ""}
    ${text ? `<div class="bubble">${rich(text)}</div>` : ""}`;
  $$(".imgs img", wrap).forEach((img) => {
    img.tabIndex = 0; img.setAttribute("role", "button"); img.setAttribute("aria-label", "放大查看截图");
    img.addEventListener("click", () => openImagePreview(img.src, img.title));
    img.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openImagePreview(img.src, img.title); } });
  });
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
async function restoreHistory(viewOverride) {
  const switchSeq = S.sessionSwitchSeq;
  const r = viewOverride ? { ok: true, data: viewOverride } : await window.halo.snapshotView();
  if (switchSeq !== S.sessionSwitchSeq) return;
  if (!r?.ok) throw new Error(r?.error || "无法恢复会话");
  const view = r.data;
  applyState(view.state);
  restoredEventSeq = view.seq;
  const msgs = [...(view.messages || [])];
  if (view.partial) msgs.push({ ...view.partial, __partial: true });
  // 历史回放不播入场动效（切换会话/启动时保持安静）
  $("#messages").classList.add("restoring");
  const toolCards = new Map(); // toolCallId -> 卡片引用，用于回填 toolResult
  /* 逐条恢复（分块渲染：每帧最多 CHUNK 条，大会话不阻塞 UI） */
  let turnStart = null, savedTiming = null;
  const restoreOne = (m) => {
    const timestamp = m.timestamp ? new Date(m.timestamp).getTime() : null;
    if (m.role !== 'user' && S.turn && timestamp) S.turn.__endedAt = savedTiming?.end || timestamp;
    if (m.role === "user") {
      const { text, images } = userMessageParts(m);
      if (text.trim() || images.length) {
        finalizeTurn(); renderUserMsg(text, images);
        S.lastUserPrompt = { text: userMessageText(text), images };
        savedTiming = view.turnTimings?.[String(m.timestamp)] || null;
        turnStart = savedTiming?.start || timestamp;
      }
      return;
    }
    if (m.role === "toolResult") {
      // 回填到对应工具卡片：状态点/耗时/输出
      const rec = toolCards.get(m.toolCallId);
      if (rec) {
        const text = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        if (!m.isError) collectArtifactResult(S.turn, rec.toolName, text,
          m.timestamp && rec.startedAt ? new Date(m.timestamp) - rec.startedAt : undefined);
        rec.out.dataset.has = "1";
        rec.out.textContent = text ? trunc(text, 4000) : (m.isError ? "（无输出）" : "（完成）");
        if (!m.isError && AUTO_OPEN_TOOLS.has(rec.toolName) && text.trim()) rec.out.hidden = false;
        rec.card.classList.remove("running");
        rec.card.classList.add(m.isError ? "error" : "done");
        if (m.timestamp && rec.startedAt) {
          const secs = (new Date(m.timestamp) - rec.startedAt) / 1000;
          if (secs >= 0.5) rec.elapsedEl.textContent = (secs < 60 ? `${secs.toFixed(1)}秒` : formatDuration(secs));
        }
      }
      return;
    }
    if (m.role !== "assistant") return;
    const turn = ensureTurn();
    turn.__history = true;
    turn.__startedAt = turnStart;
    turn.__endedAt = savedTiming?.end || timestamp;
    turn.__estimated = !savedTiming;
    for (const c of m.content || []) {
      if (c.type === "thinking") {
        if (!c.thinking || !c.thinking.trim()) continue;
        // 与实时渲染一致：折叠的思考块，点开看全文
        const d = document.createElement("details");
        d.className = "think";
        d.innerHTML = `<summary><span class="diamond">◆</span><span class="think-preview"></span><span class="think-label">思考</span></summary><div class="think-body"></div>`;
        turn.appendChild(d);
        $(".think-body", d).innerHTML = rich(c.thinking);
        $(".think-preview", d).textContent = thinkPreviewText(c.thinking);
        if (m.__partial) {
          S.thinkStreamed = true;
          S.thinking = { el: d, body: $(".think-body", d), label: $(".think-label", d), preview: $(".think-preview", d), buf: c.thinking, t0: view.startedAt || Date.now() };
        }
      } else if (c.type === "toolCall") {
        // 与实时渲染一致的工具时间线，输出区待对应 toolResult 回填
        const card = document.createElement("div");
        card.className = "tool running";
        card.innerHTML = `
          <div class="tool-line" title="${esc(c.name)}">
            <span class="tool-dot"></span>
            <span class="tool-name">${esc(toolLabel(c.name))}</span>
            <span class="tool-arg">${esc(trunc(toolDesc(c.name, c.arguments), TRUNC_TOOL_ARG))}</span>
            <span class="tool-elapsed"></span>
            <svg class="tool-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
          </div>
          <div class="tool-out" hidden></div>`;
        const out = $(".tool-out", card);
        $(".tool-line", card).addEventListener("click", () => { if (out.dataset.has) out.hidden = !out.hidden; });
        turn.appendChild(card);
        toolCards.set(c.id, { card, out, arg: $(".tool-arg", card), elapsedEl: $(".tool-elapsed", card), toolName: c.name, startedAt: m.timestamp ? new Date(m.timestamp).getTime() : 0 });
      } else if (c.type === "text") {
        if (!c.text || !c.text.trim()) continue;
        const md = document.createElement("div");
        md.className = "md";
        md.innerHTML = rich(c.text);
        turn.appendChild(md);
        turn.__texts.push(c.text);
        if (m.__partial) { S.assistant = md; S.assistantText = c.text; }
      }
    }
  };
  await new Promise((resolve) => {
    let i = 0;
    const CHUNK = 24;
    const step = () => {
      if (switchSeq !== S.sessionSwitchSeq) { resolve(); return; }
      const end = Math.min(i + CHUNK, msgs.length);
      for (; i < end; i++) restoreOne(msgs[i]);
      if (i < msgs.length) requestAnimationFrame(step);
      else resolve();
    };
    step();
  });
  if (switchSeq !== S.sessionSwitchSeq) return;
  // 没等到结果的工具调用：会话仍在执行则交给实时事件流续接（同步到 S.toolCards），否则标成完成
  const live = !!view.state?.isStreaming;
  for (const [id, rec] of toolCards) {
    if (rec.card.classList.contains("running") && live) {
      S.toolCards.set(id, rec);
      continue;
    }
    if (rec.card.classList.contains("running")) {
      rec.card.classList.remove("running");
      rec.card.classList.add("done");
      rec.out.dataset.has = "1";
      rec.out.textContent = "（无结果记录）";
    }
  }
  if (live) {
    const turn = ensureTurn();
    turn.__history = false;
    turn.__estimated = false;
    turn.__startedAt = view.startedAt || turnStart || Date.now();
    turn.__toolCount = $$(".tool", turn).length;
    compactToolTimeline(turn);
    S.streamingTool = Object.values(view.activeTools || {}).join("、") || null;
    setStreamingUI(true);
    updateTurnStatus();
    showTurnArtifacts(turn);
  } else finalizeTurn();
  scrollDown();
  // 同步插入已完成（期间无帧绘制），此刻移除才不会触发入场动画
  $("#messages").classList.remove("restoring");
  scrollDown(true);
}

/* ============================================================
   sessions / resources / models
   ============================================================ */
let sessionListRequest = 0;
async function loadSessions() {
  const request = ++sessionListRequest, cwd = S.state?.cwd;
  loadProjects();
  const r = await window.halo.listSessions();
  if (request !== sessionListRequest || cwd !== S.state?.cwd) return;
  S.sessions = r?.data || [];
  const cur = normPath(S.state?.sessionFile || "");
  const list = $("#sessionList");
  if (!S.sessions.length) {
    list.innerHTML = `<div class="res-empty">当前项目还没有会话</div>`;
    return;
  }
  list.innerHTML = "";
  for (const s of S.sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    // 右侧正在显示的会话在左侧高亮标记，避免分不清当前处于哪个对话
    const isCur = cur && normPath(s.file || "") === cur;
    if (isCur) item.classList.add("active");
    const file = (s.file || "").split(/[\\/]/).pop().replace(/\.jsonl$/, "");
    const main = document.createElement("button");
    main.className = "s-main";
    main.innerHTML = `<span class="s-head"><span class="s-name">${esc(s.name || friendlySession(file))}</span>
      ${s.running ? `<span class="s-run"><i class="s-busy"></i>运行中</span>` : ""}</span>
      <span class="s-meta">${s.modified ? new Date(s.modified).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}${s.messageCount != null ? " · " + s.messageCount + "条" : ""}</span>`;
    main.addEventListener("click", () => {
      // 多会话并发：执行中也可切换会话，后台任务继续运行
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
    }, CONFIRM_RESET_MS);
    return;
  }
  clearTimeout(item._confirmTimer);
  const isCurrent = normPath(S.state?.sessionFile || "") === normPath(s.file || "");
  if (isCurrent && S.streaming) return toast("任务进行中，先按 Esc 中止再删除", "err");
  del.disabled = true;
  window.halo.deleteSession(s.file)
    .then(async (r) => {
      if (!r?.ok) throw new Error(r?.error || "删除失败");
      if (r.data?.switched) {
        clearChat();
        await restoreHistory();
        toast("会话已删除", "ok");
      } else {
        toast("会话已删除", "ok");
      }
      await Promise.all([loadSessions(), refreshServers()]);
    })
    .catch((e) => { toast(e.message || "删除失败", "err"); loadSessions(); refreshServers(); });
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
  if (!saved || !saved.cwd) { await restoreHistory(); return; }
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
      toast("已恢复上次的会话", "ok");
    }
  }
  await restoreHistory();
}

async function openSession(file) {
  const seq = ++S.sessionSwitchSeq;
  S.switchingSession = true;
  clearChat();
  try {
    const r = await window.halo.openSession(file);
    if (seq !== S.sessionSwitchSeq) return;
    clearChat();
    if (r?.data) applyState(r.data); // 清理旧视图后再同步焦点流状态，运行中的会话仍显示“中止”
    await restoreHistory();
    if (seq !== S.sessionSwitchSeq) return;
    loadSessions();
  } catch (e) {
    if (seq === S.sessionSwitchSeq) toast(`打开失败：${e?.message || e}`, "err");
  } finally {
    if (seq === S.sessionSwitchSeq) finishSessionSwitch();
  }
}

async function newSession() {
  if (S.switchingSession) return;
  // 多会话并发：执行中也可开新会话，原任务后台继续
  const seq = ++S.sessionSwitchSeq;
  S.switchingSession = true;
  clearChat();
  try {
    const r = await window.halo.newSession();
    if (seq !== S.sessionSwitchSeq) return;
    if (r?.data) applyState(r.data);
    toast("新会话已开启", "ok");
    loadSessions();
  } catch (e) {
    if (seq === S.sessionSwitchSeq) toast(`新建失败：${e?.message || e}`, "err");
  } finally {
    if (seq === S.sessionSwitchSeq) finishSessionSwitch();
  }
}

function finishSessionSwitch() {
  S.switchingSession = false;
  const events = pendingSessionEvents;
  pendingSessionEvents = [];
  for (const item of events) handlePiEvent(item.event, item.sessionId, item.seq);
}

function clearChat() {
  restoredEventSeq = 0;
  $("#messages").innerHTML = "";
  S.toolCards.clear();
  S.assistant = null;
  S.turn = null;
  S.assistantText = "";
  S.thinking = null;
  S.streamingTool = null;
  S.retrying = null;
  S.lastUserPrompt = null;
  S.activity = [];
  S.queued = { steering: [], followUp: [] };
  renderQueue();
  setStreamingUI(false);
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
    b.addEventListener("click", () => { $("#input").value = `/skill:${b.dataset.skill} `; autoGrow(); $("#input").focus(); }));
  $("#promptList").querySelectorAll("[data-prompt]").forEach((b) =>
    b.addEventListener("click", () => { $("#input").value = `/${b.dataset.prompt} `; autoGrow(); $("#input").focus(); }));
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
async function openFileExternally(file) {
  if (!file) return toast("请先选择文件", "err");
  try {
    const result = await window.halo.openPath(file);
    if (!result?.ok) throw new Error(result?.error || "无法打开文件");
  } catch (error) { toast("外部打开失败：" + (error?.message || error), "err"); }
}

function wireUI() {
  document.querySelectorAll('[data-starter]').forEach(button => {
    button.addEventListener('click', () => {
      const input = $("#input");
      input.value = input.value.trim() ? input.value + '\n' + button.dataset.starter : button.dataset.starter;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  });
  $("#btnOpenFile").addEventListener("click", () => openFileExternally(S.previewFile));
  // window controls
  $("#winMin").addEventListener("click", () => window.halo.minimize());
  $("#winMax").addEventListener("click", () => window.halo.maximize());
  $("#winClose").addEventListener("click", () => window.halo.close());
  let themeTransition = null;
  let targetTheme = document.documentElement.dataset.theme;
  $('#themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    targetTheme = (themeTransition ? targetTheme : root.dataset.theme) === 'light' ? 'dark' : 'light';
    const next = targetTheme;
    themeTransition?.skipTransition();
    const update = () => applyTheme(next);
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { update(); return; }
    root.classList.add('theme-x');
    const transition = document.startViewTransition(update);
    themeTransition = transition;
    transition.finished.catch(() => {}).finally(() => {
      if (themeTransition === transition) { themeTransition = null; root.classList.remove('theme-x'); }
    });
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

  // 侧栏展开/收起（彻底收起；状态记忆）
  try { if (localStorage.getItem("halo.sbCollapsed") === "1") document.body.classList.add("sb-collapsed"); } catch {}
  $("#btnSidebar").addEventListener("click", () => applyPreviewLayout(() => {
    const collapsed = document.body.classList.toggle("sb-collapsed");
    try { localStorage.setItem("halo.sbCollapsed", collapsed ? "1" : "0"); } catch {}
  }));
  $$("#settingsModal .set-nav").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#settingsModal .set-nav").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll("#settingsModal .set-pane").forEach((p) => p.classList.toggle("active", p.id === "setPane-" + b.dataset.pane));
    if (b.dataset.pane === "usage") loadUsage(); // 打开面板时刷新统计
    if (b.dataset.pane === "environment") void environmentSettings?.refresh();
    if (b.dataset.pane === "video") void videoSettings?.refresh();
    if (b.dataset.pane === "login") void loadDefaultModels();
  }));
  $("#usageRange").addEventListener("click", (e) => {
    const b = e.target.closest("[data-d]");
    if (!b) return;
    $$("#usageRange .ptab").forEach((x) => x.classList.toggle("active", x === b));
    S.usageDays = Number(b.dataset.d) || 30;
    loadUsage(); // 有缓存立即渲染，无缓存才出占位符
  });
  $("#pkgSearchInput").addEventListener("input", debounce(() => {
    S.pkgQuery = $("#pkgSearchInput").value.trim();
    if (S.pkgType === "installed") renderInstalled(); // 已安装列表本地过滤
    else loadMarket(1); // 搜索重回第一页
  }, 350));
  $("#pkgTabs").addEventListener("click", (e) => {
    const b = e.target.closest(".ptab");
    if (!b) return;
    S.pkgType = b.dataset.t;
    $$("#pkgTabs .ptab").forEach((x) => x.classList.toggle("active", x === b));
    syncPkgTab();
  });
  $("#pkgPrev").addEventListener("click", () => loadMarket(Math.max(1, (S.pkgPage || 1) - 1)));
  $("#pkgNext").addEventListener("click", () => loadMarket((S.pkgPage || 1) + 1));
  $("#pkgUpdateAll").addEventListener("click", updateAllPkgs);
  $("#pkgApply").addEventListener("click", applyPkgChanges);
  $("#pkgInstalled").addEventListener("click", onInstalledClick);
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
  $("#authList").addEventListener("dblclick", (e) => {
    const chip = e.target.closest("[data-acc-chip]");
    if (chip) beginAccountRename(chip);
  });
  $("#authList").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-auth-prompt-input]")) window.halo.authRespond(e.target.value.trim());
    if (e.key === "Enter" && e.target.matches("[data-auth-input]")) saveApiKey(e.target.dataset.authInput);
  });

  $("#modelSearch").addEventListener("input", (e) => renderModelList(e.target.value));

  // attachments & project
  $("#btnAttach").addEventListener("click", attachImages);
  $("#projAdd").addEventListener("click", pickProject);

  // chat header
  $("#btnPreviewToggle").addEventListener("click", () => applyPreviewLayout(() => {
    document.body.classList.remove("focus-mode");
    const collapsed = document.body.classList.toggle("preview-collapsed");
    const button = $("#btnPreviewToggle");
    button.title = collapsed ? "展开预览区" : "收起预览区";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(!collapsed));
    $("#center").inert = collapsed;
    $("#btnFocus").title = "专注模式 · 对话全屏（隐藏侧栏与工作区）";
  }));
  $("#btnFocus").addEventListener("click", () => applyPreviewLayout(() => {
    const on = document.body.classList.toggle("focus-mode");
    $("#btnFocus").title = on ? "退出专注模式（恢复侧栏与工作区）" : "专注模式 · 对话全屏（隐藏侧栏与工作区）";
  }));

  window.initTerminals(() => S.state?.cwd || "", toast);

  // composer
  const input = $("#input");
  input.addEventListener("keydown", (e) => {
    if (handleMentionKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.altKey) {
        const t = input.value.trim();
        if (t && S.streaming) send("followUp");
      } else {
        send();
      }
    }
  });
  input.addEventListener("input", autoGrow);
  input.addEventListener("input", updateMentions);
  input.addEventListener("click", updateMentions);
  input.addEventListener("keyup", (e) => { if (["ArrowLeft", "ArrowRight"].includes(e.key)) updateMentions(); });
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".input-shell")) closeMentions(); });
  let mentionContext = "";
  document.addEventListener("projectstatechange", () => {
    const context = (S.state?.cwd || "") + "|" + (S.state?.sessionId || "");
    if (context !== mentionContext) { mentionContext = context; closeMentions(); }
  });
  $("#btnSend").addEventListener("click", () => {
    // streaming + text -> steer; streaming + empty -> abort
    if (S.streaming) {
      const t = input.value.trim();
      if (t || S.images.length) send();
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
    if (document.querySelector("select:open")) return;
    if (document.querySelector(".image-viewer[open]")) return;
    const open = $(".modal.show");
    if (open) { closeModal(open); return; }
    if (S.streaming) abort();
  });

  // think chip button
  $("#btnThink").addEventListener("click", () => { renderThinkList(); openModal("thinkModal"); });
  $("#btnModel").addEventListener("click", () => openModal("modelModal"));
  $("#ctxQuota").addEventListener("click", openUsageDetails);
  $('#ctxVideoQuota').addEventListener('click', openVideoUsage);
  $('#refreshVideoUsage').addEventListener('click', () => { void loadVideoBalance(); void openVideoUsage(); });
  $("#ctxQuota").tabIndex = 0;
  $("#ctxQuota").setAttribute("role", "button");
  $("#ctxQuota").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openUsageDetails(); } });
  $("#refreshUsageDetail").addEventListener("click", openUsageDetails);

  // paste images
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) addImageFile(f);
  });

  // Project folders from the OS: resolve native File paths in the isolated preload.
  const projectDropZone = $('[data-pane="chat"]');
  let projectDropBusy = false;
  let projectDragDepth = 0;
  const clearProjectDrag = () => {
    projectDragDepth = 0;
    projectDropZone.classList.remove('project-drop-active');
  };
  const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
  projectDropZone.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    projectDragDepth++;
    projectDropZone.classList.add('project-drop-active');
  });
  projectDropZone.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = projectDropBusy ? 'none' : 'link';
  });
  projectDropZone.addEventListener('dragleave', () => {
    if (--projectDragDepth <= 0) clearProjectDrag();
  });
  projectDropZone.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearProjectDrag();
    if (projectDropBusy) return toast('正在添加项目，请稍候', 'err');
    // Read DataTransfer before the first await; browsers clear it after dispatch.
    const dirs = [...new Set(Array.from(e.dataTransfer.files, file => window.halo.droppedFilePath(file)).filter(Boolean))];
    if (!dirs.length) return toast('请从文件管理器拖入项目文件夹', 'err');
    projectDropBusy = true;
    try {
      for (const dir of dirs) await switchProjectViaAdd(dir);
    } catch (error) {
      toast('添加失败：' + error.message, 'err');
    } finally {
      projectDropBusy = false;
      $('#projList').style.opacity = '';
    }
  });
  document.addEventListener('dragend', clearProjectDrag);
  document.addEventListener('drop', clearProjectDrag);
  window.addEventListener('blur', clearProjectDrag);

  // drop images
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    for (const f of files) addImageFile(f);
  });

  wireCenter();

  // 额度：初始拉取；此后在每轮对话结束（agent_settled）时动态刷新
  if (S.state?.model?.provider) loadQuota(S.state.model.provider, true);
}

/* ============================================================
   center: preview（唯一面板，文件列表已移至侧栏底部）
   ============================================================ */
function wireCenter() {
  $("#treeRefresh").addEventListener("click", () => loadTree(true));
  $("#btnNewFile").addEventListener("click", () => startCreate("file"));
  $("#btnNewDir").addEventListener("click", () => startCreate("dir"));
  // 预览模式切换：渲染 / 源码
  $("#pvMode").addEventListener("click", () => {
    if (!S.previewFile || $("#pvMode").hidden) return;
    S.previewMode = S.previewMode === "render" ? "source" : "render";
    setPreview(S.previewFile, true);
  });

  // 预览设备切换：电脑 / 平板 / 手机
  const devSize = { desktop: "100%", tablet: "768px", mobile: "390px" };
  $$(".pvdev").forEach((b) => b.addEventListener("click", () => {
    $$(".pvdev").forEach((x) => x.classList.toggle("active", x === b));
    const body = $("#pvBody");
    if (body.classList.contains("dev-" + b.dataset.dev)) return;
    applyPreviewLayout(() => {
      body.classList.remove("dev-desktop", "dev-tablet", "dev-mobile");
      body.classList.add("dev-" + b.dataset.dev);
    });
    window.halo.previewTouch?.(b.dataset.dev !== "desktop"); // 平板/手机模式：隐藏滚动条 + 触摸式拖动
    const size = $("#pvDevSize");
    if (size) size.textContent = devSize[b.dataset.dev] || "100%";
  }));
}

// Resize the real page once; never stretch or continuously relayout its canvas.
function syncPreviewMotion() {
  const paused = !!$('.modal:not([hidden]), .image-viewer[open]') ||
    document.body.classList.contains('preview-collapsed') || document.body.classList.contains('focus-mode');
  return window.halo.previewMotion?.(paused).catch(() => {});
}
function applyPreviewLayout(change) {
  change();
  syncPreviewMotion();
}

/* ---- file tree ---- */
async function loadTree(force) {
  const r = await window.halo.readTree();
  const data = r?.data;
  if (!data) return;
  S.treeData = data;
  if (document.querySelector('.nav-item.active')?.dataset.tab !== 'skills') {
    $("#wsPath").textContent = data.root;
    $("#wsPath").title = data.root;
  }
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
const PV_EMPTY = `<div class="pv-empty"><div class="pv-ghost"><div class="pv-gscreen"><div class="pv-empty-ico">◇</div><p>实时预览</p><p class="dim">点击文件查看</p></div><div class="pv-gneck"></div><div class="pv-gbase"></div></div></div>`;

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
      let kid = null;
      let kidsBuilt = false;
      row.className = "trow" + (n.dir ? " dir" : " file") + (S.expanded.has(n.path) ? " open" : "") + (changedSet.has(norm(n.path)) ? " changed" : "") + (S.selectedFile === n.path ? " selected" : "");
      row.style.paddingLeft = 8 + depth * 14 + "px";
      row.innerHTML = n.dir
        ? `<span class="arrow">▶</span><span class="fic">${FOLDER_IC}</span><span class="fname">${esc(n.name)}</span><button class="trow-del" title="删除">${TRASH_IC}</button>`
        : `<span class="arrow"></span><span class="fic">${fileIconFor(n.name)}</span><span class="fname">${esc(n.name)}</span><span class="fsize">${fmtSize(n.size || 0)}</span><button class="trow-del" title="删除">${TRASH_IC}</button>`;
      row.title = n.path;
      if (!n.dir) {
        const open = document.createElement("button");
        open.className = "trow-external";
        open.title = "使用默认应用打开";
        open.setAttribute("aria-label", "使用默认应用打开 " + n.name);
        open.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg>';
        open.addEventListener("click", e => { e.stopPropagation(); openFileExternally(n.path); });
        row.insertBefore(open, row.querySelector('.trow-del'));
      }
      row.addEventListener("click", () => {
        S.selectedFile = n.path;
        if (n.dir) {
          const open = !S.expanded.has(n.path);
          open ? S.expanded.add(n.path) : S.expanded.delete(n.path);
          row.classList.toggle("open", open);
          row.setAttribute("aria-expanded", String(open));
          $$(".trow.selected", el).forEach(r => r.classList.remove("selected"));
          row.classList.add("selected");
          if (open && !kidsBuilt) { build(n.children || [], depth + 1, kid, n.path); kidsBuilt = true; }
          const height = kid.hidden ? 0 : kid.getBoundingClientRect().height;
          const opacity = kid.hidden ? 0 : Number(getComputedStyle(kid).opacity);
          kid._animation?.cancel();
          kid.hidden = false;
          kid.inert = !open;
          const finish = () => { kid.hidden = !open; kid.style.overflow = ""; kid._animation = null; };
          if (matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
          kid.style.overflow = "hidden";
          kid._animation = kid.animate([
            { height: height + "px", opacity },
            { height: (open ? kid.scrollHeight : 0) + "px", opacity: open ? 1 : 0 },
          ], { duration: 240, easing: "cubic-bezier(.22,1,.36,1)" });
          kid._animation.onfinish = finish;
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
        if (S.previewFile && normSlashes(S.previewFile).startsWith(d)) { S.previewFile = null; $("#btnOpenFile").hidden = true; $("#pvMode").hidden = true; $("#pvName").textContent = "未选择文件"; $("#pvBody").innerHTML = PV_EMPTY; }
        if (S.selectedFile && normSlashes(S.selectedFile).startsWith(d)) S.selectedFile = null;
        if (S.creating?.parent && normSlashes(S.creating.parent).startsWith(d)) S.creating = null;
        await loadTree(true);
      });
      container.appendChild(row);
      if (n.dir) {
        // 空文件夹也构建子容器，便于行内新建
        kid = document.createElement("div");
        kid.className = "tree-kids";
        kid.hidden = !S.expanded.has(n.path);
        kid.inert = kid.hidden;
        row.setAttribute("aria-expanded", String(!kid.hidden));
        if (!kid.hidden) { build(n.children || [], depth + 1, kid, n.path); kidsBuilt = true; }
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

/* 预览支持的类型由 setPreview 内联判断（html/图片/md/文本） */

function recordActivity(rec) {
  // 仅记录：文件树用 .changed 标记新改动文件
  S.activity.unshift(rec);
  if (S.activity.length > 60) S.activity.pop();
}

/* ---- preview ---- */
/* ---- 预览 URL（定义在 markdown.js，函数声明挂全局，供两处使用） ---- */
const currentPreviewDevice = () => {
  const c = $("#pvBody").classList;
  return c.contains("dev-tablet") ? "tablet" : c.contains("dev-mobile") ? "mobile" : "desktop";
};

function previewDeviceStatusbar() {
  const now = new Date();
  const time = now.getHours() + ":" + String(now.getMinutes()).padStart(2, "0");
  return `<div class="dev-statusbar" aria-hidden="true"><span class="dsb-time">${time}</span><span class="dsb-cam"></span><span class="dsb-icons">` +
    `<svg viewBox="0 0 16 12"><rect x="0" y="7" width="2.5" height="5" rx="0.8"/><rect x="4" y="5" width="2.5" height="7" rx="0.8"/><rect x="8" y="3" width="2.5" height="9" rx="0.8"/><rect x="12" y="1" width="2.5" height="11" rx="0.8" opacity="0.4"/></svg>` +
    `<svg viewBox="0 0 16 12"><path d="M8 10.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z"/><path d="M3.6 7.2a6.2 6.2 0 0 1 8.8 0l-1.4 1.4a4.2 4.2 0 0 0-6 0Z"/><path d="M1.2 4.8a9.6 9.6 0 0 1 13.6 0l-1.4 1.4a7.6 7.6 0 0 0-10.8 0Z"/></svg>` +
    `<svg viewBox="0 0 22 12"><rect x="0.5" y="1.5" width="18" height="9" rx="2.5" fill="none" stroke="currentColor" stroke-width="1"/><rect x="2.2" y="3.2" width="11" height="5.6" rx="1.2"/><rect x="19.8" y="4" width="2" height="4" rx="1"/></svg>` +
    `</span></div>`;
}

function mediaPreviewShell(media) {
  const shell = document.createElement('div');
  shell.className = 'dev-shell dev-media-shell';
  shell.innerHTML = `${previewDeviceStatusbar()}<div class="dev-screen"></div>`;
  shell.querySelector('.dev-screen').appendChild(media);
  return shell;
}

async function setPreview(p, force) {
  if (!p) return;
  if (!force && S.previewFile === p) return;
  const request = ++portPreviewRequest;
  previewService = null; selectedPortKey = null; updatePortSelection();
  S.previewFile = p; $("#btnOpenFile").hidden = !p;
  const ext = p.split(".").pop().toLowerCase();
  $("#pvName").textContent = p.split(/[\\\\/]/).pop();
  const body = $("#pvBody");
  const isHtml = ext === "html" || ext === "htm";
  const modeCtl = $("#pvMode");
  if (modeCtl) {
    modeCtl.hidden = !isHtml;
    modeCtl.textContent = S.previewMode === "source" ? "渲染" : "源码";
    modeCtl.title = S.previewMode === "source" ? "渲染页面" : "查看源代码";
    modeCtl.ariaLabel = modeCtl.title;
  }
  if (["pdf", "docx", "xlsx", "pptx", "doc", "xls", "ppt"].includes(ext)) {
    body.innerHTML = '<div class="fv-note">正在加载文档…</div>';
    let page = 1, pages = 1;
    const load = async () => {
      const r = await window.halo.documentPreview(p, page);
      if (request !== portPreviewRequest) return;
      if (!r?.ok) { body.innerHTML = '<div class="fv-note">' + esc(r?.error || '预览失败') + '</div>'; return; }
      if (ext === 'pdf') {
        pages = r.data.pages;
        body.innerHTML = '<div class="document-preview"><div class="document-canvas"><img alt="PDF 页面" /></div><nav aria-label="文档翻页"><span class="document-kind">PDF</span><div class="document-pages"><button id="docPrev" title="上一页" aria-label="上一页">‹</button><span>' + page + ' / ' + pages + '</span><button id="docNext" title="下一页" aria-label="下一页">›</button></div><span class="document-fit">适合宽度</span></nav></div>';
        body.querySelector('img').src = r.data.image;
        body.querySelector('#docPrev').disabled = page <= 1;
        body.querySelector('#docNext').disabled = page >= pages;
        for (const [id, delta] of [['docPrev', -1], ['docNext', 1]]) body.querySelector('#' + id).onclick = () => { page += delta; body.querySelectorAll('button').forEach(b => b.disabled = true); load(); };
      } else {
        const frame = document.createElement('iframe');
        frame.className = 'office-frame'; frame.sandbox = 'allow-scripts allow-same-origin';
        frame.src = 'document-viewer.html';
        const ready = event => {
          if (event.source !== frame.contentWindow || event.data?.type !== 'office-ready') return;
          window.removeEventListener('message', ready);
          if (request === portPreviewRequest) frame.contentWindow.postMessage({ type: 'office-document', ...r.data }, '*');
        };
        window.addEventListener('message', ready);
        frame.addEventListener('load', () => setTimeout(() => window.removeEventListener('message', ready), 10000), { once: true });
        body.replaceChildren(frame);
      }
    };
    await load();
  } else if (["mp4", "webm"].includes(ext)) {
    const player = document.createElement('video'); player.className = 'pv-video'; player.controls = true; player.preload = 'metadata';
    player.src = previewURL(p); player.setAttribute('aria-label', '视频预览'); body.replaceChildren(mediaPreviewShell(player));
  } else if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    const img=document.createElement('img');img.className='pv-img';img.alt='图片预览';
    img.onerror=()=>{if(request===portPreviewRequest)body.innerHTML='<div class="fv-note">图片已移动、删除或无法读取，请从文件列表重新选择。</div>';};
    img.src=previewURL(p);body.replaceChildren(mediaPreviewShell(img));
  } else if (["md", "markdown"].includes(ext)) {
    body.innerHTML = `<div class="md-view">加载中…</div>`;
    const r = await window.halo.readFile(p);
    if (request !== portPreviewRequest) return;
    body.innerHTML = r?.data
      ? `<div class="md-view">${mdRender(r.data.content, r.data.path || p)}</div>`
      : `<div class="pv-empty"><p>无法读取：${esc(r?.error || "")}</p></div>`;
  } else if (["html", "htm"].includes(ext) || ext === "htm") {
    if (S.previewMode === "source") {
      // 源码模式：语法高亮 + 行号（HTML 源码可读）
      body.innerHTML = `<div class="file-view"><div class="fv-note">加载中…</div></div>`;
      const r = await window.halo.readFile(p);
    if (request !== portPreviewRequest) return;
      if (!r?.data) {
        body.innerHTML = `<div class="file-view"><div class="fv-note">无法读取：${esc(r?.error || "")}</div></div>`;
        return;
      }
      const content = r.data.truncated ? r.data.content.slice(0, 300000) : r.data.content;
      const lineCount = content.split("\n").length;
      const nums = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
      body.innerHTML = `<div class="file-view"><div class="fv-code"><div class="fvc-ln">${nums}</div><pre class="fvc-body">${hlFile(content, "html")}</pre></div></div>`;
    } else {
      body.innerHTML = `<div class="dev-shell">${previewDeviceStatusbar()}<iframe src="${previewURL(p)}"></iframe></div>`;
      window.halo.previewTouch?.(currentPreviewDevice() !== "desktop");
    }
  } else {
    // 文本文件：代码类 → 语法高亮行号视图；纯文本类 → 阅读视图
    body.innerHTML = `<div class="file-view"><div class="fv-note">加载中…</div></div>`;
    const r = await window.halo.readFile(p);
    if (request !== portPreviewRequest) return;
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
  const d = r?.data || { files: [], skipped: [] };
  const imgs = (d.files || []).map((i) => ({
    ...i,
    mediaType: normImageMime(i.mediaType) || sniffImageMime(i.data) || "image/png",
  }));
  S.images.push(...imgs);
  renderAttachments();
  if (d.skipped?.length) toast(`已跳过超大图片：${d.skipped.join("、")}（单张上限 25MB）`, "err");
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
    if (bytes > IMG_DOWNSCALE.maxBytes) {
      const small = await downscaleImage(img.data, img.mediaType, IMG_DOWNSCALE.maxEdge, IMG_DOWNSCALE.quality);
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

function openImagePreview(src, name = "截图", gallery = [{ src, name }], initialIndex = 0) {
  let index = initialIndex;
  const dialog = document.createElement("dialog");
  dialog.className = "image-viewer";
  dialog.setAttribute("aria-label", "截图预览");
  dialog.innerHTML = '<header><span></span><button type="button" autofocus aria-label="关闭预览">×</button></header><div class="image-viewer-stage"><img alt="" /></div><footer><button class="image-prev" type="button" aria-label="上一张"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 7-5 5 5 5"/></svg></button><span class="image-counter" aria-live="polite"></span><button class="image-next" type="button" aria-label="下一张"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 7 5 5-5 5"/></svg></button></footer>';
  $("header span", dialog).textContent = name || "截图";
  const image = $("img", dialog);
  const show = (next) => {
    index = (next + gallery.length) % gallery.length;
    const item = gallery[index];
    image.src = item.src;
    image.alt = item.name || "截图";
    $("header span", dialog).textContent = item.name || "截图";
    $(".image-counter", dialog).textContent = (index + 1) + " / " + gallery.length;
    dialog.classList.remove("actual-size");
    $(".image-viewer-stage", dialog).scrollTo(0, 0);
  };
  $(".image-prev", dialog).addEventListener("click", () => show(index - 1));
  $(".image-next", dialog).addEventListener("click", () => show(index + 1));
  $(".image-prev", dialog).disabled = $(".image-next", dialog).disabled = gallery.length < 2;
  show(index);
  image.addEventListener("click", () => dialog.classList.toggle("actual-size"));
  $("button", dialog).addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog || e.target.classList.contains("image-viewer-stage")) dialog.close(); });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dialog.close(); }
    if (["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      show(index + (["ArrowUp", "ArrowLeft"].includes(e.key) ? -1 : 1));
    }
  });
  dialog.addEventListener("close", () => { dialog.remove(); syncPreviewMotion(); }, { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();
  syncPreviewMotion();
}

function renderAttachments() {
  S.composerRevision++;
  const row = $("#attachRow");
  row.hidden = S.images.length === 0;
  row.innerHTML = "";
  S.images.forEach((img, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.innerHTML = `<button class="attach-preview" type="button" title="放大查看截图"><img src="data:${img.mediaType};base64,${img.data}" alt="" /><span>${esc(trunc(img.name, 18))}</span></button><button class="attach-remove" title="移除">×</button>`;
    $(".attach-preview", chip).addEventListener("click", () => openImagePreview(`data:${img.mediaType};base64,${img.data}`, img.name, S.images.map((item) => ({ src: `data:${item.mediaType};base64,${item.data}`, name: item.name })), i));
    $(".attach-remove", chip).addEventListener("click", () => { S.images.splice(i, 1); renderAttachments(); });
    row.appendChild(chip);
  });
}

/* ---- project (A9: no-op when unchanged) ---- */
async function applyProjectReset() {
  portPreviewRequest++; previewService = null; selectedPortKey = null; updatePortSelection();
  clearChat();
  S.previewFile = null; $("#btnOpenFile").hidden = true; $("#pvMode").hidden = true;
  $("#pvBody").innerHTML = PV_EMPTY;
  $("#pvName").textContent = "未选择文件";
  S.expanded.clear();
  S.creating = null;
}

async function pickProject() {
  const prev = S.state?.cwd || "";
  const r = await window.halo.pickProject(prev);
  const dir = r?.data;
  if (!dir) return;
  if (normPath(dir) === normPath(S.state?.cwd || "")) return;
  // The picker only selects a directory. projectAdd registers it and switches
  // through the main process's serialized session transition.
  await switchProjectViaAdd(dir);
}
async function switchProjectViaAdd(dir) {
  const seq = ++S.sessionSwitchSeq;
  S.switchingSession = true;
  toast(`正在添加项目 · ${String(dir).split(/[\\/]/).pop()}…`, "");
  const box = $("#projList");
  if (box) box.style.opacity = "0.5";
  try {
    const r = await window.halo.projectAdd(dir);
    if (seq !== S.sessionSwitchSeq) return;
    if (!r?.ok) return toast(`添加失败：${r?.error || ""}`, "err");
    applyProjectReset();
    await restoreHistory();
    if (seq !== S.sessionSwitchSeq) return;
    await Promise.all([loadTree(true), loadSessions(), loadResources(), loadProjects()]);
    if (seq !== S.sessionSwitchSeq) return;
    saveWorkspace();
    toast(`已添加项目 · ${String(dir).split(/[\\/]/).pop()}`, "ok");
  } finally {
    if (seq === S.sessionSwitchSeq) {
      if (box) box.style.opacity = "";
      finishSessionSwitch();
    }
  }
}

/* ---- 项目：一个项目 = 一个文件夹，各自记住上一个对话 ---- */
function addConversationFold(toggle, children, collapsed, key, name) {
  const fold = document.createElement('button');
  fold.className = 'conversation-fold';
  fold.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
  let animation = null;
  const sync = () => {
    const expanded = !collapsed.has(key);
    fold.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-expanded', String(expanded));
    fold.setAttribute('aria-label', (expanded ? '收起' : '展开') + name + '的会话');
    fold.title = expanded ? '收起会话' : '展开会话';
  };
  sync();
  const toggleExpanded = e => {
    e.stopPropagation();
    const expand = collapsed.has(key);
    const fromHeight = children.getBoundingClientRect().height;
    const style = getComputedStyle(children);
    const fromOpacity = children.hidden ? 0 : Number(style.opacity);
    const fromMargin = children.hidden ? '0px' : style.marginTop;
    animation?.cancel();
    if (expand) collapsed.delete(key); else collapsed.add(key);
    sync();
    children.hidden = false;
    children.inert = !expand;
    const finish = () => {
      children.hidden = !expand;
      children.style.overflow = '';
      animation = null;
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    const targetHeight = expand ? children.scrollHeight : 0;
    const targetMargin = expand ? getComputedStyle(children).marginTop : '0px';
    children.style.overflow = 'hidden';
    animation = children.animate([
      { height: fromHeight + 'px', opacity: fromOpacity, marginTop: fromMargin },
      { height: targetHeight + 'px', opacity: expand ? 1 : 0, marginTop: targetMargin },
    ], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    animation.onfinish = finish;
  };
  fold.addEventListener('click', toggleExpanded);
  toggle.addEventListener('click', toggleExpanded);
  toggle.before(fold);
  return sync;
}

const collapsedProjects = new Set();
let projectListRequest = 0;
async function loadProjects() {
  const request = ++projectListRequest;
  const box = $("#projList");
  if (!box) return;
  const r = await window.halo.projectsList();
  if (request !== projectListRequest) return;
  if (!r?.ok) { toast(r?.error || "项目列表读取失败", "err"); return; }
  const list = r?.data || [];
  box.replaceChildren();
  if (!list.length) { box.innerHTML = '<div class="res-empty">还没有项目，点上方“＋ 添加”</div>'; return; }
  for (const p of list) {
    const group = document.createElement("div"); group.className = "project-group server-group" + (p.active ? " current" : "");
    group.innerHTML = '<div class="project-group-head server-group-head"><button class="project-toggle server-group-toggle"><svg viewBox="0 0 24 24" class="ic"><path d="M3 7h6l2 2h10l-3 11H3Z M3 7V4h6l2 3h8v2"/></svg><span></span></button><details class="server-group-menu" name="server-actions"><summary title="项目操作">···</summary><div><button class="project-remove server-group-remove" title="移除项目（不删除文件）">移除项目</button></div></details><button class="project-new server-group-new" title="新建对话"><svg viewBox="0 0 24 24" class="ic"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M14 5l5 5M10 14l1-5 7-7 5 5-7 7Z"/></svg></button></div><div class="project-conversations server-conversations"></div>';
    $(".project-toggle span", group).textContent = p.name;
    const toggle = $(".project-toggle", group), children = $(".project-conversations", group);
    toggle.title = p.cwd;
    children.hidden = collapsedProjects.has(p.cwd);
    addConversationFold(toggle, children, collapsedProjects, p.cwd, p.name);
    $(".project-remove", group).addEventListener("click", () => removeWorkspaceItem(() => window.halo.projectRemove(p.cwd)));
    $(".project-new", group).addEventListener("click", async () => {
      if (!p.active) { await switchProject(p.cwd); if (normPath(S.state?.cwd) !== normPath(p.cwd)) return; }
      collapsedProjects.delete(p.cwd); await newSession(); await loadProjects(); $("#input").focus();
    });
    if (!p.sessions?.length) children.innerHTML = '<div class="server-conversation-empty">暂无对话，点击右上角新建</div>';
    for (const session of p.sessions || []) {
      const row = document.createElement("div"); row.className = "project-conversation server-conversation-row";
      const button = document.createElement("button"); button.className = "project-conversation-name server-conversation";
      button.textContent = session.name || "新会话"; button.title = session.name || "新会话";
      if (normPath(session.file) === normPath(S.state?.sessionFile)) button.classList.add("active");
      if (session.running) { const dot = document.createElement("i"); dot.className = "server-running-dot"; button.prepend(dot); }
      button.addEventListener("click", async () => {
        if (!p.active) { await switchProject(p.cwd); if (normPath(S.state?.cwd) !== normPath(p.cwd)) return; }
        await openSession(session.file); loadProjects();
      });
      const remove = document.createElement("button"); remove.className = "project-conversation-remove server-conversation-delete"; remove.title = "删除会话"; remove.setAttribute("aria-label", "删除会话 " + (session.name || "新会话"));
      remove.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>';
      remove.addEventListener("click", () => requestDeleteSession(session, row, remove));
      row.append(button, remove); children.appendChild(row);
    }
    box.appendChild(group);
  }
}
async function removeWorkspaceItem(remove, serverId = null) {
  if (S.switchingSession) return;
  closeServerMenus();
  const seq = ++S.sessionSwitchSeq;
  S.switchingSession = true;
  try {
    const r = await remove();
    if (seq !== S.sessionSwitchSeq) return;
    if (!r?.ok) throw Error(r?.error || "移除失败");
    if (serverId && browsingServerId === serverId) browsingServerId = null;
    const reset = r.data.switched || (serverId && previewService?.serverId === serverId);
    if (reset) await applyProjectReset();
    applyState(r.data.state);
    if (reset) await restoreHistory();
    if (seq !== S.sessionSwitchSeq) return;
    await Promise.all([loadTree(true), loadSessions(), loadResources(), loadProjects(), refreshServers()]);
    saveWorkspace();
  } catch (e) {
    if (seq === S.sessionSwitchSeq) toast(e?.message || "移除失败", "err");
  } finally {
    if (seq === S.sessionSwitchSeq) finishSessionSwitch();
  }
}
async function switchProject(cwd) {
  const seq = ++S.sessionSwitchSeq;
  S.switchingSession = true;
  clearChat();
  try {
    const r = await window.halo.projectSwitch(cwd);
    if (seq !== S.sessionSwitchSeq) return;
    if (!r?.ok) throw new Error(r?.error || "切换失败");
    applyProjectReset();
    if (r.data) applyState(r.data);
    await restoreHistory();
    if (seq !== S.sessionSwitchSeq) return;
    await Promise.all([loadTree(true), loadSessions(), loadResources(), loadProjects()]);
    saveWorkspace();
  } catch (e) {
    if (seq === S.sessionSwitchSeq) toast(e?.message || "切换失败", "err");
  } finally {
    if (seq === S.sessionSwitchSeq) finishSessionSwitch();
  }
}

/* ============================================================
   modals / toast / misc
   ============================================================ */
const modalCloseTimers = new WeakMap();
function openModal(id) {
  const m = document.getElementById(id);
  clearTimeout(modalCloseTimers.get(m));
  m.hidden = false;
  modalCloseTimers.delete(m);
  syncPreviewMotion();
  m.classList.add("show");
  if (id === "modelModal") { $("#modelSearch").value = ""; loadModels(); }
}
function closeModal(m) {
  const el = m || $(".modal.show");
  if (!el) return;
  el.classList.remove("show");
  clearTimeout(modalCloseTimers.get(el));
  modalCloseTimers.set(el, setTimeout(() => {
    el.hidden = true;
    modalCloseTimers.delete(el);
    syncPreviewMotion();
  }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180));
}

/* 提示气泡：错误/警告始终显示（静默失败 = 用户无感知，属缺陷）；
 * 成功/信息提示默认静音（尊重“不弹提示”的偏好），localStorage "halo.toasts"="all" 时恢复全部 */
function toast(text, kind = "") {
  if (!text) return;
  try {
    if (kind !== "err" && kind !== "warn" && localStorage.getItem("halo.toasts") !== "all") return;
  } catch {}
  const wrap = $("#toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = text;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 450); }, 3600);
}

function autoGrow() {
  S.composerRevision++;
  const input = $("#input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

function scrollDown(force = false) {
  const m = $("#messages");
  if (m.classList.contains("restoring")) return;
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
  loadAccountQuotas(); // 异步补齐每个账户的剩余额度
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
      p.hasStored && !p.currentId ? `<button class="mini-btn" data-acc-capture="${esc(p.id)}" title="把当前登录身份保存为一个账户，之后可一键切回">存为账户</button>` : "",
      p.configured ? `<button class="mini-btn" data-auth-logout="${esc(p.id)}">登出</button>` : "",
    ].filter(Boolean).join("");
    const curId = p.currentId || p.activeId || null;
    const acctsHtml = (p.accounts || []).length ? `<div class="auth-accts" data-acc-strip="${esc(p.id)}">
      ${(p.accounts || []).map((a) => {
        const on = a.id === curId;
        const qt = formatQuotaShort(a.quota);
        const tip = [on ? "当前使用中" : "点击切换使用该账户额度",
          a.plan ? `订阅 ${a.plan}` : "", "双击重命名",
          a.savedAt ? `保存于 ${relTime(new Date(a.savedAt).toISOString())}` : ""].filter(Boolean).join(" · ");
        return `<span class="acc-chip${on ? " on" : ""}" data-acc-chip="${esc(p.id)}" data-acc-id="${esc(a.id)}" title="${esc(tip)}">
          <span class="acc-main"><i class="acc-dot"></i><span class="acc-label">${esc(a.label)}</span></span>
          ${qt ? `<span class="acc-quota">${esc(qt)}</span>` : ""}
          <button class="acc-x" data-acc-x="${esc(p.id)}" data-acc-id="${esc(a.id)}" title="删除该账户（不影响其他账户）">×</button>
        </span>`;
      }).join("")}
    </div>` : "";
    return `<div class="auth-row" data-auth-row="${esc(p.id)}">
      <div class="auth-name"><span>${esc(p.name)}</span>${status}<small>${esc(p.id)}</small></div>
      <div class="auth-actions">${actions}</div>
      ${acctsHtml}
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
  // 多账户（注意：acc-x 需先于 acc-chip 判断，× 按钮嵌在芯片内）
  const accDel = e.target.closest("[data-acc-x]");
  if (accDel) { removeAccount(accDel.dataset.accX, accDel.dataset.accId, accDel); return; }
  const accChip = e.target.closest("[data-acc-chip]");
  if (accChip) { switchAccount(accChip.dataset.accChip, accChip.dataset.accId); return; }
  const accSave = e.target.closest("[data-acc-capture]");
  if (accSave) { captureAccount(accSave.dataset.accCapture); return; }
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
  } catch (_e) {
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

/* ---------------- 多账户：保存 / 一键切换 / 删除 / 重命名 ----------------
   账户身份保存在 ~/.pi/agent/halo-accounts.json；切换 = 把保存的凭据
   写回 auth.json（与 pi CLI 共享），额度随账户一起切换。 */

async function switchAccount(providerId, accountId) {
  const strip = $(`[data-acc-strip="${CSS.escape(providerId)}"]`);
  if (strip?.classList.contains("busy")) return;
  strip?.classList.add("busy");
  S.quota = { provider: providerId, data: null }; // 切换中先置空，避免闪烁旧账户额度
  renderQuotaChip();
  try {
    const r = await window.halo.authAccountSwitch(providerId, accountId);
    if (r?.ok) {
      toast(`已切换账户：${r.data.label}`, "ok");
      // 切换结果已带上新账户的额度：直接更新底部额度条，不显示旧账户的过期数据
      if (r.data.quota) { S.quota = { provider: providerId, data: r.data.quota }; renderQuotaChip(); }
    } else {
      toast(`切换失败：${r?.error || "未知错误"}`, "err");
      loadQuota(providerId, true); // 失败恢复：重新拉当前（未变）账户的额度
    }
  } catch (e) {
    toast(`切换失败：${e?.message || e}`, "err");
    loadQuota(providerId, true);
  }
  strip?.classList.remove("busy");
  await renderAuthList();
  updateAuthSummary();
  await loadModels();
  await ensureModelAvailable();
}

async function captureAccount(providerId) {
  const r = await window.halo.authAccountCapture(providerId)
    .catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (r?.ok) {
    toast(`已保存账户「${r.data.label}」`, "ok");
    await renderAuthList();
  } else {
    toast(`保存失败：${r?.error || "未知错误"}`, "err");
  }
}

function removeAccount(providerId, accountId, btn) {
  const chip = btn.closest(".acc-chip");
  if (!chip) return;
  if (!chip.dataset.confirm) {
    // 两步确认：第一次点 × 变为「确认?」，2.6s 内再点才真正删除
    chip.dataset.confirm = "1";
    chip.classList.add("confirm-del");
    btn.textContent = "确认?";
    setTimeout(() => {
      if (chip.isConnected && chip.dataset.confirm) {
        delete chip.dataset.confirm;
        chip.classList.remove("confirm-del");
        btn.textContent = "×";
      }
    }, CONFIRM_RESET_MS);
    return;
  }
  window.halo.authAccountRemove(providerId, accountId).then(async (r) => {
    if (r?.ok) { toast("已删除账户", "ok"); await renderAuthList(); }
    else toast(`删除失败：${r?.error || "未知错误"}`, "err");
  });
}

function beginAccountRename(chip) {
  if ($(".acc-input", chip)) return;
  const labelEl = $(".acc-label", chip);
  if (!labelEl) return;
  const old = labelEl.textContent;
  const input = document.createElement("input");
  input.className = "acc-input";
  input.value = old;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (save && val && val !== old) {
      const r = await window.halo.authAccountRename(chip.dataset.accChip, chip.dataset.accId, val).catch(() => null);
      if (r?.ok) { // 同步本地缓存，避免重渲染回退旧名称
        const acc = (authRows.find((x) => x.id === chip.dataset.accChip)?.accounts || []).find((a) => a.id === chip.dataset.accId);
        if (acc) acc.label = val;
      }
    }
    renderAuthRows(); // 内存数据重渲染，不重新拉取
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
    else if (ev.key === "Escape") { ev.stopPropagation(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
}

/* 拉取各供应商下每个账户的剩余额度，到达后合并进本地缓存并重绘芯片 */
const accQuotaInFlight = new Set();
function loadAccountQuotas() {
  for (const p of authRows) {
    if (!(p.accounts || []).length || accQuotaInFlight.has(p.id)) continue;
    accQuotaInFlight.add(p.id);
    window.halo.authAccountQuotas(p.id)
      .then((r) => {
        if (!r?.ok || !Array.isArray(r.data)) return;
        const row = authRows.find((x) => x.id === p.id);
        if (!row) return;
        let changed = false;
        for (const q of r.data) {
          const acc = (row.accounts || []).find((a) => a.id === q.id);
          if (acc && JSON.stringify(acc.quota) !== JSON.stringify(q.quota)) { acc.quota = q.quota; changed = true; }
        }
        if (changed) renderAuthRows();
      })
      .catch(() => {})
      .finally(() => accQuotaInFlight.delete(p.id));
  }
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
function syncWallpaperTransparency() {
  const cover = parseFloat(document.documentElement.style.getPropertyValue('--wallpaper-cover'));
  const value = Math.round(100 * (1 - (Number.isFinite(cover) ? cover : .65)));
  $('#wallpaperTransparency').value = value;
  $('#wallpaperTransparencyValue').value = value + '%';
}
$('#wallpaperTransparency').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  document.documentElement.style.setProperty('--wallpaper-cover', String(1 - value / 100));
  try { localStorage.setItem('halo-wallpaper-transparency', String(value)); } catch {}
  syncWallpaperTransparency();
});
function syncThemeChoices() {
  syncWallpaperTransparency();
  $$("[data-theme-choice]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeChoice === (document.documentElement.dataset.wallpaper || document.documentElement.dataset.theme))));
}
document.addEventListener("themechange", syncThemeChoices);
$("#settingsAuth").addEventListener("click", () => { closeModal($("#settingsModal")); openAuthModal(); });
$$("[data-theme-choice]").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeChoice)));

function openSettings() {
  syncThemeChoices();
  openModal("settingsModal");
  if ($("#setPane-environment").classList.contains("active")) void environmentSettings?.refresh();
  if ($("#setPane-video").classList.contains("active")) void videoSettings?.refresh();
  if ($("#setPane-login").classList.contains("active")) void loadDefaultModels();
  S.pkgLoaded = true;
  loadInstalled(); // 已安装数据每次打开都刷新
  syncPkgTab();    // 市场数据按需加载
}
/** 已安装 / 市场 两个分区的显隐切换（搜索框两边共用，分别过滤各自列表） */
function syncPkgTab() {
  const inst = S.pkgType === "installed";
  const mSec = $("#pkgMarketSec"), iSec = $("#pkgInstalledSec");
  if (!mSec || !iSec) return;
  mSec.hidden = inst;
  iSec.hidden = !inst;
  const pager = $("#pkgPager");
  if (pager) pager.hidden = inst; // 翻页器只在市场 tab 显示
  if (!inst) loadMarket(1);
  else renderInstalled(); // 用当前搜索词过滤已装列表
}
let selectedModelProvider = "";
async function loadDefaultModels() {
  const list = $("#defModelList");
  if (!list) return;
  list.innerHTML = `<div class="pkg-empty">读取模型列表…</div>`;
  const [mr, dr] = await Promise.all([window.halo.listModels(), window.halo.defaultModelGet()]);
  const models = (mr?.data || []).filter((m) => !m.error);
  let cur = dr?.data || "";
  if (!models.length) {
    list.innerHTML = `<div class="pkg-empty">尚未发现可用模型，请先通过 pi 登录</div>`;
    return;
  }
  const groups = new Map();
  for (const m of models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }

  list.innerHTML='<nav class="model-providers" aria-label="模型供应商"></nav><div class="provider-models"></div>';
  const nav=list.querySelector('.model-providers'),panel=list.querySelector('.provider-models');
  if(!groups.has(selectedModelProvider)) selectedModelProvider=groups.has(cur.split('/')[0])?cur.split('/')[0]:groups.keys().next().value;
  const buttons=new Map();
  const renderProvider=prov=>{
    selectedModelProvider=prov;
    for(const [id,b] of buttons){b.classList.toggle('on',id===prov);b.setAttribute('aria-pressed',String(id===prov));}
    panel.replaceChildren();panel.scrollTop=0;
    const ms=groups.get(prov);
    for (const m of ms) {
      const key = m.provider + "/" + m.id;
      const isCur = cur === key;
      const row = document.createElement("button");
      row.type="button";
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
          cur=key;
          list.querySelectorAll(".agent-row").forEach((x) => x.classList.toggle("on", x === row));
          toast(`默认模型已设置：${m.name}`, "ok");
        } else toast(`设置失败：${r?.error || ""}`, "err");
      });
      panel.appendChild(row);
    }
  };
  for(const [prov,ms] of groups){
    const b=document.createElement('button');b.type='button';b.className='model-provider';b.title=prov;
    const name=document.createElement('span');name.textContent=prov;
    const count=document.createElement('small');count.textContent=ms.length;
    b.append(name,count);b.onclick=()=>renderProvider(prov);buttons.set(prov,b);nav.appendChild(b);
  }
  renderProvider(selectedModelProvider);
}

/* ---- 用量统计 ---- */
let videoUsageRequest = 0;
async function openVideoUsage() {
  openModal('videoUsageModal');
  const seq = ++videoUsageRequest, body = $('#videoUsageBody');
  body.innerHTML = '<div class="model-empty">正在读取记录…</div>';
  try {
    const reply = await window.halo.videoHistory();
    if (seq !== videoUsageRequest) return;
    if (!reply?.ok) throw Error(reply?.error || '读取失败');
    body.replaceChildren();
    if (!reply.data.length) { body.textContent = '暂无视频生成记录'; return; }
    for (const job of reply.data) {
      const row = document.createElement('div'); row.className = 'usage-session-row';
      const main = document.createElement('div'), title = document.createElement('b'), detail = document.createElement('small');
      title.textContent = `${job.providerName} · ${job.model}`;
      detail.textContent = `${job.createdAt ? new Date(job.createdAt).toLocaleString() : ''} · ${job.resolution || '—'} · ${job.duration || '—'} 秒`;
      main.append(title, detail);
      const numbers = document.createElement('div'); numbers.className = 'usage-session-numbers';
      const amount = document.createElement('strong'), status = document.createElement('small');
      const actual = job.actual, estimate = job.estimate;
      const value = Number.isFinite(actual?.amount) ? actual.amount : estimate?.total;
      const unit = Number.isFinite(actual?.amount) ? actual.unit : estimate?.currency;
      amount.textContent = Number.isFinite(value) ? `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)} ${unit === 'Credits' ? '积分' : unit || ''}` : '消耗未返回';
      status.textContent = `${({delivered:'已完成', succeeded:'生成成功', failed:'失败', queued:'排队中', processing:'生成中'})[job.status] || job.status || '未知状态'} · ${Number.isFinite(actual?.amount) ? '实际消耗' : '暂无实际消耗'}`;
      if (!Number.isFinite(actual?.amount) && Number.isFinite(value)) amount.textContent = '预估 ' + amount.textContent;
      row.title = `任务 ${job.id}`;
      numbers.append(amount, status); row.append(main, numbers); body.append(row);
    }
  } catch {
    if (seq === videoUsageRequest) body.innerHTML = '<div class="model-empty">读取失败，请点击刷新重试</div>';
  }
}
let usageDetailRequest = 0;
async function openUsageDetails() {
  openModal("usageDetailModal");
  const seq = ++usageDetailRequest;
  const body = $("#usageDetailBody");
  body.innerHTML = '<div class="model-empty">正在统计本地会话…</div>';
  const result = await window.halo.usageSummary(36500).catch(() => null);
  if (seq !== usageDetailRequest) return;
  if (!result?.ok) { body.innerHTML = '<div class="model-empty">统计失败，请点击刷新重试</div>'; return; }
  const d = result.data, today = d.today || {}, rows = d.sessionDetails || [];
  body.innerHTML = '<div class="usage-summary-heading"><b>今日用量</b><span>'+esc(today.date || '')+'</span></div><div class="usage-cards">' +
    '<div class="usage-card"><small>Token</small><b>'+fmtTokens(today.totalTokens || 0)+'</b></div>' +
    '<div class="usage-card" title="按本地记录估算，非实际扣款；订阅模型可能显示为 0"><small>预估费用 · USD</small><b>'+fmtCost(today.cost || 0)+'</b></div></div>' +
    '<div class="usage-history-heading"><b>历史记录 <span>'+rows.length+'</span></b><span>累计预估 <strong>'+fmtCost(d.totals?.cost || 0)+'</strong></span></div><div id="usageSessionRows"></div>';
  const list = $("#usageSessionRows");
  if (!rows.length) list.textContent = "暂无用量记录";
  for (const r of rows) {
    const row = document.createElement("div"); row.className = "usage-session-row";
    row.innerHTML = '<div><b></b><small></small></div><div class="usage-session-numbers"><strong>'+fmtCost(r.cost || 0)+'</strong><small>'+fmtTokens(r.totalTokens || 0)+' Token</small></div>';
    $("b", row).textContent = r.name;
    $("b", row).title = r.name;
    $("small", row).textContent = (r.cwd.split(/[\\/]/).pop() || "未知项目") + " · " + new Date(r.modified).toLocaleDateString();
    row.title = "输入 " + r.input + " · 输出 " + r.output + " · 缓存 " + (r.cacheRead+r.cacheWrite);
    list.appendChild(row);
  }
}

function fmtCost(n) {
  if (!n) return "$0";
  if (n >= 100) return "$" + n.toFixed(0);
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}
async function loadUsage(force = false) {
  const box = $("#usageContent");
  if (!box) return;
  const cached = S.usageCache.has(S.usageDays);
  if (cached && !force) { renderUsage(S.usageCache.get(S.usageDays)); return; }
  if (!cached) {
    // 首次查看该范围：占位符居中（外层高度已固定，不会坍塌）
    box.innerHTML = `<div class="set-soon">正在扫描会话记录…</div>`;
  } else {
    // 已有内容：保留旧数据只变暗，扫完后静默替换，不清空
    box.classList.add("refreshing");
  }
  const r = await window.halo.usageSummary(S.usageDays).catch(() => null);
  box.classList.remove("refreshing");
  if (!r?.ok) {
    if (cached) { toast(`用量刷新失败：${r?.error || "未知错误"}`, "err"); renderUsage(S.usageCache.get(S.usageDays)); }
    else box.innerHTML = `<div class="set-soon">统计失败：${esc(r?.error || "未知错误")}</div>`;
    return;
  }
  S.usageCache.set(S.usageDays, r.data);
  renderUsage(r.data);
}
function renderUsage(d) {
  const box = $("#usageContent");
  if (!box) return;
  const t = d.totals || {};
  const range = S.usageDays;

  /* 日维度柱状图：范围内日期连续填充，无数据的天高度为 0 */
  const dayMap = new Map((d.daily || []).map((x) => [x.date, x]));
  const days = [];
  for (let i = range - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const key = dt.toISOString().slice(0, 10);
    days.push({ key, label: `${dt.getMonth() + 1}/${dt.getDate()}`, ...(dayMap.get(key) || { calls: 0, tokens: 0, cost: 0, totalTokens: 0 }) });
  }
  const maxDay = Math.max(...days.map((x) => x.totalTokens || 0), 1);
  const chart = days.map((x) => `
    <div class="u-bar${x.totalTokens ? "" : " zero"}" style="height:${Math.max((x.totalTokens / maxDay) * 100, x.totalTokens ? 3 : 1.5)}%"
         title="${x.label} · ${fmtTokens(x.totalTokens)} tokens · ${fmtCost(x.cost)} · ${x.calls} 次"></div>`).join("");

  /* 模型排行 */
  const maxModel = Math.max(...(d.models || []).map((m) => m.totalTokens || 0), 1);
  const modelRows = (d.models || []).map((m) => `
    <div class="u-row">
      <div class="u-main">
        <div class="u-name"><b>${esc(m.key.split("/")[1] || m.key)}</b><small>${esc(m.key)}</small></div>
        <div class="u-nums">${m.calls} 次 · ${fmtTokens(m.totalTokens)} tok · ${fmtCost(m.cost)}</div>
      </div>
      <div class="u-track"><i style="width:${Math.max((m.totalTokens / maxModel) * 100, 2)}%"></i></div>
      <div class="u-sub">输入 ${fmtTokens(m.input)} · 输出 ${fmtTokens(m.output)} · 缓存 ${fmtTokens(m.cacheRead + m.cacheWrite)}</div>
    </div>`).join("") || `<div class="pkg-empty">范围内没有模型调用记录</div>`;

  /* 项目分布 */
  const projRows = (d.projects || []).map((p) => {
    const name = p.cwd.split(/[\\/]/).filter(Boolean).pop() || p.cwd;
    return `<div class="u-prow"><span class="u-pname" title="${esc(p.cwd)}">${esc(name)}</span>
      <span class="u-pnum">${fmtTokens(p.totalTokens)} tok · ${fmtCost(p.cost)}</span></div>`;
  }).join("");

  box.innerHTML = `
    <div class="set-sec">
      <div class="usage-cards">
        <div class="usage-card"><b>${fmtCost(t.cost)}</b><small>总花费</small></div>
        <div class="usage-card"><b>${fmtTokens(t.totalTokens)}</b><small>总 tokens</small></div>
        <div class="usage-card"><b>${t.calls ?? 0}</b><small>调用次数</small></div>
        <div class="usage-card"><b>${d.sessions ?? 0}</b><small>会话数</small></div>
      </div>
      <div class="u-note">输入 ${fmtTokens(t.input)} · 输出 ${fmtTokens(t.output)} · 缓存读 ${fmtTokens(t.cacheRead)} · 缓存写 ${fmtTokens(t.cacheWrite)}</div>
    </div>
    <div class="set-sec">
      <h4>每日 tokens <span class="set-count">近 ${range} 天</span></h4>
      <div class="usage-chart">${chart}</div>
      <div class="u-axis"><span>${days[0]?.label || ""}</span><span>${days[days.length - 1]?.label || ""}</span></div>
    </div>
    <div class="set-sec">
      <h4>模型排行 <span class="set-count">按 tokens</span></h4>
      <div class="usage-rows">${modelRows}</div>
    </div>
    ${projRows ? `<div class="set-sec"><h4>项目分布</h4><div class="usage-projs">${projRows}</div></div>` : ""}`;
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
  renderInstalled();
}
/** 渲染已安装列表（按搜索词本地过滤，data-i 保留原始索引供操作定位） */
function packageIntroUrl(p) {
  const npmName = p.name || (p.kind === "npm" ? p.raw.replace(/^npm:/, "").replace(/@[^/]+$/, "") : "");
  for (const raw of [p.homepage, p.repo, npmName ? "https://www.npmjs.com/package/" + npmName : ""]) {
    try {
      const url = new URL(String(raw || "").replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, ""));
      if (["https:", "http:"].includes(url.protocol)) return url.href;
    } catch {}
  }
  return "";
}
function introButton(p) {
  const url = packageIntroUrl(p);
  return url ? '<button class="mini-btn pkg-intro" data-pkg-url="'+esc(url)+'" title="打开插件介绍">查看介绍 ↗</button>' : '<span class="pkg-kind">未提供介绍链接</span>';
}
function openPackageIntro(e) {
  const button = e.target.closest("[data-pkg-url]");
  if (!button) return false;
  window.halo.openExternal(button.dataset.pkgUrl).catch(() => toast("无法打开介绍链接", "err"));
  return true;
}

function renderInstalled() {
  const box = $("#pkgInstalled");
  if (!box) return;
  const list = S.pkgInstalledList || [];
  if (!list.length) {
    box.innerHTML = `<div class="pkg-empty">尚未安装任何包，可在“插件与技能”的市场中安装</div>`;
    return;
  }
  const q = (S.pkgQuery || "").toLowerCase();
  const rows = list.map((p, i) => ({ p, i })).filter(({ p }) => !q || (p.raw || "").toLowerCase().includes(q));
  if (!rows.length) {
    box.innerHTML = `<div class="pkg-empty">没有匹配“${esc(S.pkgQuery)}”的已安装包</div>`;
    return;
  }
  box.innerHTML = rows.map(({ p, i }) => {
    const name = esc(p.raw.replace(/^npm:/, ""));
    const ver = p.update ? `<span class="pkg-ver upd" title="${esc(p.version)} → ${esc(p.latest)}">${esc(p.version)} → ${esc(p.latest)}</span>` : p.version ? `<span class="pkg-ver">v${esc(p.version)}</span>` : "";
    return `<div class="pkg-row${p.disabled ? " off" : ""}" data-i="${i}">
      <div class="pkg-main">
        <span class="pkg-name">${name}</span>
        ${ver}
        <span class="pkg-kind">${p.kind === "npm" ? "npm" : p.kind === "git" ? "git" : "本地"}</span>
        ${p.disabled ? `<span class="pkg-off-badge">已停用</span>` : ""}
        <div class="pkg-installed-desc">${esc(p.desc || "暂未提供简短说明，可打开介绍页面查看功能与用法。")}</div>
      </div>
      <div class="pkg-ops">
        <button class="ext-switch${p.disabled ? "" : " on"}" data-act="toggle" title="${p.disabled ? "启用" : "停用"}"></button>
        ${introButton(p)}
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
  if (S.pkgLoaded) loadMarket(1);
}
const PAGE_SIZE = 20;
async function loadMarket(page) {
  if (S.pkgType === "installed") return; // 已安装 tab 不需要市场数据（切回时 syncPkgTab 会重新加载）
  if (page) S.pkgPage = page;
  S.pkgPage = S.pkgPage || 1;
  const box = $("#pkgMarket");
  box.innerHTML = `<div class="pkg-empty">加载中…</div>`;
  const typeParam = ["extension", "skill", "theme", "prompt"].includes(S.pkgType) ? S.pkgType : "";
  const r = await window.halo.pkgSearch({ query: S.pkgQuery || "", from: (S.pkgPage - 1) * PAGE_SIZE, size: PAGE_SIZE, type: typeParam });
  if (!r?.ok) {
    box.innerHTML = `<div class="pkg-empty">加载失败：${esc(r?.error || "")}</div>`;
    renderPager();
    return;
  }
  const items = r.data?.items || [];
  S.pkgItems = items;
  S.pkgTotal = r.data?.total || 0;
  const installedNorm = new Set((S.pkgInstalledList || []).map((p) => normPkgSource(p.raw)));
  const list = items.filter((p) => !installedNorm.has(normPkgSource("npm:" + p.name)));
  if (!list.length) {
    box.innerHTML = `<div class="pkg-empty">${items.length ? "本页的包都已安装，可翻下一页" : "没有找到匹配的包"}</div>`;
  } else {
    box.innerHTML = list.map((p) => {
      const badges = (p.types || []).map((t) => `<span class="pkg-type t-${t}">${PKG_TYPE_CN[t] || t}</span>`).join("");
      const repo = introButton(p);
      return `<div class="pkg-card">
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
        <button class="mini-btn accent" data-act="install" data-name="${esc(p.name)}">安装</button>
      </div>
    </div>`;
    }).join("");
  }
  renderPager();
}
/** 翻页器：页码指示 + 上一/下一页按钮状态 */
function renderPager() {
  const total = S.pkgTotal || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(S.pkgPage || 1, pages);
  const info = $("#pkgPageInfo");
  if (info) info.textContent = total ? `第 ${cur} / ${pages} 页 · 共 ${total} 个` : "";
  const prev = $("#pkgPrev"), next = $("#pkgNext");
  if (prev) prev.disabled = cur <= 1;
  if (next) next.disabled = !total || cur >= pages;
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
  if (openPackageIntro(e)) return;
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
      if (S.pkgLoaded) loadMarket(1);
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
  if (openPackageIntro(e)) return;
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
    loadMarket(1);
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

/* markdown 渲染（rich/mdRender/hlFile/langOf 等）已移至 js/markdown.js（经典脚本，全局函数） */

function selectThemeCategory(id, focus = false) {
  $$('[data-theme-tab]').forEach(button => {
    const active = button.dataset.themeTab === id;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  $$('[data-theme-panel]').forEach(panel => { panel.hidden = panel.dataset.themePanel !== id; });
}
$$('[data-theme-tab]').forEach((button, index, tabs) => {
  button.addEventListener('click', () => selectThemeCategory(button.dataset.themeTab));
  button.addEventListener('keydown', event => {
    const offsets = {ArrowRight: 1, ArrowLeft: -1};
    if (!(event.key in offsets) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + offsets[event.key] + tabs.length) % tabs.length;
    selectThemeCategory(tabs[next].dataset.themeTab, true);
  });
});
const selectedThemeCard = $('[data-theme-choice="' + (document.documentElement.dataset.wallpaper || document.documentElement.dataset.theme) + '"]');
selectThemeCategory(selectedThemeCard?.closest('[data-theme-panel]')?.dataset.themePanel || 'nature');
