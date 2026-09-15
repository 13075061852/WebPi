import { initGitHubSettings } from './github-settings.mjs';
import { initCloudflareSettings } from './cloudflare-settings.mjs';
const TOOL_INFO = [
  { id: "python", name: "Python" },
  { id: "node", name: "Node.js" },
  { id: "git", name: "Git" },
];
const ACTIVE_STATES = new Set(["queued", "checking", "installing", "downloading", "detecting", "verifying"]);
const ERROR_STATES = new Set(["error", "failed"]);

/** Own the environment pane without mixing its asynchronous state with chat state. */
export function initEnvironmentSettings({ root = document, api = window.halo } = {}) {
  const get = (id) => root.querySelector(`#${id}`);
  const pane = get("setPane-environment");
  if (!pane) return { refresh: async () => {} };
  const doc = pane.ownerDocument;
  const github = initGitHubSettings({ root, api });
  const cloudflare = initCloudflareSettings({ root, api });
  const tools = get("environmentTools");
  const refreshButton = get("environmentRefresh");
  const installButton = get("environmentInstall");
  const repairButton = get("environmentRepair");
  let repairing = false;
  const repairPanel = get('environmentRepairPanel'), repairStatus = get('environmentRepairStatus'), repairOutput = get('environmentRepairOutput');
  let repairText = '';
  const issue = get("environmentIssue");
  const errorMessage = get("environmentError");
  const helpButton = get("environmentHelp");
  const progressSection = get("environmentProgressSection");
  const progressList = get("environmentProgress");
  let snapshot = null;
  let pending = false;
  let operation = "";
  let error = "";
  let eventRevision = 0;
  let requestId = 0;
  let progressSignature = "";

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const cards = new Map(TOOL_INFO.map((info) => {
    const card = element("article", "environment-tool");
    card.dataset.tool = info.id;
    const icon = element("span", "environment-tool-icon");
    icon.setAttribute("aria-hidden", "true");
    const logo = element("img");
    logo.src = new URL(`../assets/environment/${info.id}.svg`, import.meta.url).href;
    logo.alt = "";
    logo.draggable = false;
    icon.append(logo);
    const content = element("div", "environment-tool-content");
    const heading = element("div", "environment-tool-heading");
    const name = element("h4", "", info.name);
    const status = element("span", "environment-status", "待检测");
    status.setAttribute("role", "status");
    heading.append(name);
    const version = element("p", "environment-tool-version");
    const path = element("p", "environment-tool-path");
    const detail = element("p", "environment-tool-detail");
    content.append(heading, version, path, detail);
    card.append(icon, content, status);
    tools.append(card);
    return [info.id, { card, status, version, path, detail }];
  }));

  function safeHelpUrl() {
    try {
      const url = new URL(snapshot?.installer?.helpUrl);
      return url.protocol === "https:" ? url.href : null;
    } catch { return null; }
  }

  function acceptSnapshot(update) {
    if (!update || !Array.isArray(update.tools)) return false;
    if (Number.isFinite(update.revision) && Number.isFinite(snapshot?.revision) && update.revision < snapshot.revision) return false;
    snapshot = update;
    return true;
  }

  function render() {
    const installing = Boolean(snapshot?.installing || (pending && operation === "install"));
    const detected = snapshot?.tools || [];
    const missing = TOOL_INFO.filter(({ id }) => !detected.find((tool) => tool.id === id)?.installed);
    const history = (snapshot?.progress || []).slice(-40);
    pane.setAttribute("aria-busy", String(pending || installing));
    refreshButton.disabled = pending || installing;
    if (repairButton) {
      repairButton.disabled = pending || installing || !api?.environmentRepair;
      repairButton.hidden = repairing;
    }
    if (get('environmentRepairStop')) get('environmentRepairStop').hidden = !repairing;
    refreshButton.textContent = pending && operation === "refresh" ? "检测中…" : "重新检测";
    installButton.disabled = pending || installing || !snapshot || !missing.length || !snapshot.installer?.available;
    installButton.textContent = installing ? "正在配置…" : snapshot && !missing.length ? "环境已就绪" : "一键配置环境";

    for (const info of TOOL_INFO) {
      const view = cards.get(info.id);
      const tool = detected.find((entry) => entry.id === info.id);
      const last = history.findLast((entry) => entry.id === info.id);
      const active = installing && ACTIVE_STATES.has(last?.state);
      const failed = !tool?.installed && (tool?.problem === "broken" || ERROR_STATES.has(last?.state));
      const state = active ? "busy" : tool?.installed ? "ready" : failed ? "error" : snapshot ? "missing" : "unknown";
      view.card.dataset.state = state;
      view.status.textContent = active ? last.state === "queued" ? "等待配置" : "配置中" : tool?.installed ? "已安装" : failed ? "需要处理" : snapshot ? "未安装" : pending ? "检测中" : "待检测";
      view.version.textContent = tool?.installed ? `版本 ${tool.version || "未知"}` : "";
      view.version.hidden = !tool?.installed;
      view.path.textContent = tool?.path || "";
      view.path.title = tool?.path || "";
      view.path.hidden = !tool?.path;
      view.detail.textContent = active || (!tool?.installed && ERROR_STATES.has(last?.state)) ? last?.message || tool?.error || "" : tool?.problem === "broken" ? tool.error || "" : "";
      view.detail.hidden = !view.detail.textContent;
    }

    const unavailable = snapshot && missing.length && !snapshot.installer?.available;
    errorMessage.textContent = error || (unavailable ? snapshot.installer?.error || "此电脑暂时无法自动安装环境，请查看安装说明后重新检测。" : "");
    issue.hidden = !errorMessage.textContent;
    helpButton.hidden = !safeHelpUrl() || issue.hidden;
    progressSection.hidden = !history.length;
    const signature = JSON.stringify(history);
    if (signature !== progressSignature) {
      const atBottom = progressList.scrollHeight - progressList.scrollTop - progressList.clientHeight < 32;
      progressList.replaceChildren(...history.map((entry) => {
        const item = element("li", ERROR_STATES.has(entry.state) ? "error" : "", entry.message || "");
        return item;
      }));
      if (atBottom) progressList.scrollTop = progressList.scrollHeight;
      progressSignature = signature;
    }
  }

  async function run(kind) {
    if (pending || snapshot?.installing) return;
    const action = kind === "install" ? api?.environmentInstall : api?.environmentStatus;
    if (typeof action !== "function") {
      error = "此版本不支持环境检测，请重新启动最新版本的 Halo。";
      render();
      return;
    }
    if (kind === "install" && installButton.disabled) return;
    pending = true;
    operation = kind;
    error = "";
    const id = ++requestId;
    const startedRevision = eventRevision;
    render();
    try {
      const result = await action();
      if (id !== requestId) return;
      if (!result?.ok) throw new Error(result?.error || (kind === "install" ? "环境配置失败，请重试。" : "无法检测本地环境，请重试。"));
      // Backend revisions prevent a late status response from replacing live progress.
      if (Number.isFinite(result.data?.revision) || eventRevision === startedRevision) acceptSnapshot(result.data);
    } catch (cause) {
      if (id === requestId) error = cause?.message || String(cause);
    } finally {
      if (id === requestId) {
        pending = false;
        operation = "";
        render();
      }
    }
  }

  refreshButton.addEventListener("click", () => { void run("refresh"); void github.refresh(); void cloudflare.refresh(); });
  installButton.addEventListener("click", () => { void run("install"); });
  repairButton?.addEventListener('click', async () => {
    if (pending || snapshot?.installing || !api?.environmentRepair) return;
    pending = true; repairing = true; render();
    repairText = ''; repairPanel.hidden = false;
    repairOutput.textContent = ''; repairStatus.textContent = '正在检测环境…';
    get('environmentRepairStop').disabled = false;
    try {
      const result = await api.environmentRepair();
      if (!result?.ok) throw Error(result?.error || 'AI 修复失败');
      acceptSnapshot(result.data); repairStatus.textContent = result.data.repairSkipped ? 'Python、Node.js、Git 均已就绪，无需修复' : '修复任务已结束';
    }
    catch (cause) { error = cause?.message || 'AI 修复启动失败'; }
    finally { repairing = false; pending = false; get('environmentRepairStop').disabled = true; render(); }
  });
  get('environmentRepairStop')?.addEventListener('click', () => {
    get('environmentRepairStop').disabled = true;
    repairStatus.textContent = '正在停止…';
    void api.environmentRepairStop();
  });
  api?.onEnvironmentRepairProgress?.(event => {
    if (!repairing) return;
    if (event.type === 'tool_execution_start') repairStatus.textContent = `正在执行 ${event.toolName}`;
    if (event.type === 'agent_start') repairStatus.textContent = '正在分析环境…';
    const update = event.assistantMessageEvent;
    if (event.type === 'message_update' && update?.type === 'text_delta') {
      repairText = (repairText + update.delta).slice(-40000);
      repairOutput.textContent = repairText;
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.errorMessage) {
      repairStatus.textContent = event.message.errorMessage;
    }
  });
  helpButton.addEventListener("click", async () => {
    const url = safeHelpUrl();
    if (!url) return;
    try {
      const result = await api.openExternal(url);
      if (result?.ok === false) throw new Error(result.error || "无法打开安装说明");
    } catch (cause) {
      error = cause?.message || "无法打开安装说明";
      render();
    }
  });
  api?.onEnvironmentProgress?.((update) => {
    if (!acceptSnapshot(update)) return;
    eventRevision++;
    render();
  });
  render();
  return { refresh: async () => { await Promise.all([run('refresh'), github.refresh(), cloudflare.refresh()]); } };
}
