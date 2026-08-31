/**
 * Pi Halo — pi core agent bridge (main process, ESM)
 * Embeds the real pi coding agent via its SDK, keeping all of pi's rules:
 * extensions / skills / prompt templates / themes / AGENTS.md context files /
 * sessions tree / compaction / message queueing — discovered exactly like the CLI.
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

/* ------------------------------------------------------------------ */
/* resolve the globally installed pi package                           */
/* ------------------------------------------------------------------ */

function resolvePiImport() {
  const candidates = [];
  if (process.env.PI_HALO_PI_PATH) candidates.push(process.env.PI_HALO_PI_PATH);
  const npmRoots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : null,
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
  ].filter(Boolean);
  for (const root of npmRoots) {
    candidates.push(path.join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js"));
  }
  candidates.push("@earendil-works/pi-coding-agent");
  for (const c of candidates) {
    try {
      if (c.endsWith(".js") && fs.existsSync(c)) return pathToFileURL(c).href;
      if (c.endsWith(".js")) continue;
    } catch {}
  }
  return "@earendil-works/pi-coding-agent"; // bare specifier fallback
}

let pi = null;
export async function loadPi() {
  if (!pi) {
    pi = await import(resolvePiImport());
  }
  return pi;
}

/* ------------------------------------------------------------------ */
/* 智能体（agent）扫描：用户级 / 项目级 *.md（frontmatter + 系统提示） */
/* ------------------------------------------------------------------ */

const listAgentFiles = (dir, out, scope, depth = 0) => {
  if (depth > 3) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listAgentFiles(full, out, scope, depth + 1);
    else if (e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".chain.md")) out.push({ file: full, scope });
  }
};

export async function scanAgents(cwd) {
  const { getAgentDir } = await loadPi();
  const roots = [
    { dir: path.join(getAgentDir(), "extensions", "subagent", "agents"), scope: "builtin" },
    { dir: path.join(getAgentDir(), "agents"), scope: "user" },
    { dir: path.join(cwd || process.cwd(), ".pi", "agents"), scope: "project" },
    { dir: path.join(cwd || process.cwd(), ".agents"), scope: "project" },
  ];
  const files = [];
  for (const r of roots) listAgentFiles(r.dir, files, r.scope);
  const out = [];
  for (const { file, scope } of files) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      const fm = fmMatch ? fmMatch[1] : "";
      const name = ((fm.match(/^name:\s*(.+)$/m) || [])[1] || "").trim().replace(/^"|"$/g, "") || path.basename(file, ".md");
      const desc = ((fm.match(/^description:\s*(.+)$/m) || [])[1] || "").trim().replace(/^"|"$/g, "");
      // runner.type 非 pi 的是外部 CLI 子运行器（codex/claude 等），不能作为默认人设，跳过
      const runnerBlock = fm.match(/^runner:\s*\r?\n((?:[ \t]+.*\r?\n?)+)/m);
      const runnerType = runnerBlock ? (((runnerBlock[1].match(/type:\s*(\S+)/) || [])[1]) || "") : "";
      if (runnerType && runnerType !== "pi") continue;
      const prompt = (fmMatch ? raw.slice(fmMatch[0].length) : raw).trim();
      if (!prompt) continue;
      out.push({ name, desc, scope, path: file, prompt });
    } catch {}
  }
  // 同名去重：后扫的优先级高（项目级覆盖用户级）
  const byName = new Map();
  for (const a of out) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* app settings (small JSON store in userData)                         */
/* ------------------------------------------------------------------ */

export class HaloStore {
  constructor(file) {
    this.file = file;
    this.data = { cwd: null, modelKey: null, thinkingLevel: null, splashed: false };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {}
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {}
  }
  set(k, v) {
    this.data[k] = v;
    this.save();
  }
}

/* ------------------------------------------------------------------ */
/* the bridge                                                          */
/* ------------------------------------------------------------------ */

export class PiBridge {
  constructor(store) {
    this.store = store;
    this.runtime = null;      // AgentSessionRuntime
    this.session = null;
    this.unsubscribe = null;
    this.modelRuntime = null;
    this.cwd = store.data.cwd || null;
    // 项目列表：一个项目 = 一个文件夹，记住各自的 lastSession（首次从现有 cwd 迁移）
    if (!Array.isArray(store.data.projects)) {
      store.data.projects = this.cwd ? [{ cwd: this.cwd, lastSession: null }] : [];
      store.save();
    }
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    this.emitter = null;      // (channel, payload) => void
    this.startingPromise = null;
  }

  onEvent(emitter) {
    this.emitter = emitter;
  }

  emit(channel, payload) {
    if (this.emitter) this.emitter(channel, payload);
  }

  pushState() {
    this.emit("halo:state", this.publicState());
  }

  publicState() {
    const s = this.session;
    // 当前上下文占用：最后一条 assistant 消息的用量 ≈ 本轮请求的完整上下文（输入+缓存读写+输出）
    let contextTokens = 0;
    try {
      const msgs = s?.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const u = msgs[i]?.role === "assistant" ? msgs[i].usage : null;
        if (u) {
          contextTokens = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
          break;
        }
      }
    } catch {}
    return {
      ready: !!s,
      cwd: this.cwd,
      sessionId: s?.sessionId,
      sessionFile: s?.sessionFile,
      model: s?.model
        ? { provider: s.model.provider, id: s.model.id, name: s.model.name || s.model.id, contextWindow: s.model.contextWindow }
        : null,
      thinkingLevel: s?.thinkingLevel ?? null,
      isStreaming: !!s?.isStreaming,
      usage: this.usage,
      contextTokens,
      messageCount: s?.messages?.length ?? 0,
    };
  }

  /* ---------------- lifecycle ---------------- */

  async start(cwd) {
    if (this.startingPromise) { try { await this.startingPromise; } catch {} }
    if (cwd) this.cwd = String(cwd).replace(/\\/g, "/");
    if (!this.cwd) this.cwd = path.join(os.homedir(), "Desktop").replace(/\\/g, "/");
    this.store.set("cwd", this.cwd);

    this.startingPromise = this._doStart();
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
    this.pushState();
    return this.publicState();
  }

  async _doStart() {
    const {
      createAgentSessionRuntime,
      createAgentSessionFromServices,
      createAgentSessionServices,
      ModelRuntime,
      SessionManager,
      getAgentDir,
    } = await loadPi();

    // dispose any previous runtime/session before rebuilding (project switch)
    try {
      this.unsubscribe?.();
      this.session?.dispose?.();
    } catch {}
    this.unsubscribe = null;
    this.session = null;

    if (!this.modelRuntime) {
      this.modelRuntime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 12000 });
    }

    const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        resourceLoaderOptions: {
          extensionsOverride: (base) => {
            // 缓存全部已发现的扩展（含即将被禁用的），供能力页展示与开关
            this._allExtensions = (base.extensions || []).map((x) => ({
              name: path.basename(x.path || "") || "extension",
              path: x.path || "",
            }));
            const disabled = new Set(this.store.data.disabledExtensions || []);
            const extensions = base.extensions.filter((x) => !disabled.has(x.path));
            // Halo 默认智能体：完整 Extension 对象（path 指向真实存在的文件，loader stat 需要）；
            // handler 在每轮 agent 启动前实时读 store，把选中智能体的提示追加到系统提示
            try {
              const extFile = path.join(path.dirname(this.store.file), "halo-default-agent-ext.mjs");
              if (fs.existsSync(extFile)) {
                const self = this;
                extensions.push({
                  path: extFile,
                  resolvedPath: extFile,
                  hidden: true,
                  sourceInfo: { path: extFile, source: "halo", scope: "temporary", origin: "top-level" },
                  handlers: new Map([
                    ["before_agent_start", [async (event) => {
                      const want = self.store.data.defaultAgent;
                      if (!want) return undefined;
                      try {
                        const agents = await scanAgents(self.cwd);
                        const ag = agents.find((a) => a.name === want);
                        if (!ag || !ag.prompt) return undefined;
                        const basePrompt = event.systemPrompt || "";
                        return { systemPrompt: basePrompt + "\n\n# 当前智能体设定：" + ag.name + "\n\n" + ag.prompt };
                      } catch { return undefined; }
                    }]],
                  ]),
                  tools: new Map(),
                  messageRenderers: new Map(),
                  commands: new Map(),
                  flags: new Map(),
                  shortcuts: new Map(),
                });
              }
            } catch {}
            return { ...base, extensions };
          },
        },
      });
      this.services = services;
      return {
        ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(this.cwd),
    });

    this._bindSession();
    await this.restoreModel();
    this._noteSession();
    try {
      const saved = this.store.data;
      if (saved.thinkingLevel && this.session) {
        this.session.setThinkingLevel(saved.thinkingLevel);
      }
    } catch {}
  }

  /* 默认模型恢复：defaultModel 显式设置时总是应用；无默认则用上次使用（modelKey，仅当会话无模型） */
  async restoreModel() {
    try {
      const saved = this.store.data;
      const key = saved.defaultModel || saved.modelKey;
      if (!key || !this.session || !this.modelRuntime) return;
      if (!saved.defaultModel && this.session.model) return; // 无显式默认：尊重会话自带模型
      const [provider, ...rest] = key.split("/");
      const id = rest.join("/");
      const m = this.modelRuntime.getModel(provider, id);
      if (!m) return;
      const cur = this.session.model;
      if (cur && cur.provider === m.provider && cur.id === m.id) return;
      await this.session.setModel(m);
      this.pushState();
    } catch {}
  }

  /* ---------------- 项目（一个项目 = 一个文件夹 + 各自的会话与 lastSession） ---------------- */

  static normPath(p) {
    return String(p || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  }

  _findProject(cwd) {
    const key = PiBridge.normPath(cwd);
    return (this.store.data.projects || []).find((x) => PiBridge.normPath(x.cwd) === key);
  }

  /* 会话变化时自动记录到所属项目的 lastSession（未持久化的会话不记，落盘后由 agent_settled 补记） */
  _noteSession() {
    try {
      const sf = this.session?.sessionFile;
      if (!sf || !this.cwd || !fs.existsSync(sf)) return;
      const p = this._findProject(this.cwd);
      if (p && p.lastSession !== sf) {
        p.lastSession = sf;
        this.store.save();
      }
    } catch {}
  }

  async projectsList() {
    return (this.store.data.projects || []).map((p) => ({
      cwd: p.cwd,
      name: path.basename(p.cwd),
      lastSession: p.lastSession || null,
      active: PiBridge.normPath(p.cwd) === PiBridge.normPath(this.cwd || ""),
    }));
  }

  async addProject(dir) {
    if (!dir || !fs.existsSync(dir)) throw new Error("目录不存在：" + dir);
    if (!this._findProject(dir)) {
      (this.store.data.projects = this.store.data.projects || []).push({ cwd: dir, lastSession: null });
      this.store.save();
    }
    return this.switchProject(dir);
  }

  async removeProject(cwd) {
    const key = PiBridge.normPath(cwd);
    this.store.data.projects = (this.store.data.projects || []).filter((x) => PiBridge.normPath(x.cwd) !== key);
    this.store.save();
    return this.projectsList();
  }

  /* 切换项目：优先快路径（直接 switchSession 到该项目的上一个会话，cwdOverride 让 services 重建到目标目录，
     一次重建完成“切目录+恢复会话”）；无会话可恢复时才完整 start（慢路径） */
  async switchProject(cwd) {
    const target = String(cwd || "").replace(/\\/g, "/");
    let prev = this._findProject(target);
    // 防御：目标目录不在项目列表（旧路径切换/手工迁移残留）—— 自动补录
    if (!prev) {
      (this.store.data.projects = this.store.data.projects || []).push({ cwd: target, lastSession: null });
      this.store.save();
      prev = this._findProject(target);
    }
    const last = prev?.lastSession && fs.existsSync(prev.lastSession) ? prev.lastSession : null;
    if (last && this.runtime) {
      try {
        await this.runtime.switchSession(last, { cwdOverride: target });
        this.cwd = target;
        this.store.set("cwd", target);
        this._bindSession();
        await this.restoreModel();
        this._noteSession();
        this._recomputeUsageFromSession();
        this.pushState();
        return this.publicState();
      } catch (e) {
        console.error("[halo] fast project switch failed, fallback to full start:", e);
      }
    }
    if (PiBridge.normPath(target) !== PiBridge.normPath(this.cwd || "")) {
      await this.start(target);
    }
    if (last && this.runtime) {
      try {
        await this.runtime.switchSession(last);
        this._bindSession();
        await this.restoreModel();
      } catch (e) {
        console.error("[halo] restore project lastSession failed:", last, e);
      }
    }
    this._noteSession();
    this._recomputeUsageFromSession();
    this.pushState();
    return this.publicState();
  }

  _bindSession() {
    if (this.unsubscribe) this.unsubscribe();
    this.session = this.runtime.session;
    this.unsubscribe = this.session.subscribe((event) => {
      this._accountUsage(event);
      this.emit("pi:event", { sessionId: this.session?.sessionId, event });
      // A6: keep renderer state fresh at every meaningful boundary
      if (event?.type === "message_end" || event?.type === "agent_end" || event?.type === "agent_settled") {
        this._noteSession();
        this.pushState();
      }
    });
  }

  _accountUsage(event) {
    let u = null;
    if (event?.type === "message_end" && event.message?.role === "assistant" && event.message.usage) u = event.message.usage;
    else if (event?.type === "turn_end" && event.message?.usage) u = event.message.usage;
    if (u) {
      this.usage.input += u.input || 0;
      this.usage.output += u.output || 0;
      this.usage.cacheRead += u.cacheRead || 0;
      this.usage.cacheWrite += u.cacheWrite || 0;
      this.usage.cost += u.cost?.total || 0;
      this.pushState();
    }
  }

  /* 从会话历史消息恢复用量统计：切换会话/项目后，顶部 tokens 应显示该会话的真实累计值，
     而不是清零成 “— tokens” 占位符 */
  _recomputeUsageFromSession() {
    try {
      const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      for (const m of this.session?.messages || []) {
        const s = m?.role === "assistant" ? m.usage : null;
        if (!s) continue;
        u.input += s.input || 0;
        u.output += s.output || 0;
        u.cacheRead += s.cacheRead || 0;
        u.cacheWrite += s.cacheWrite || 0;
        u.cost += s.cost?.total || 0;
      }
      this.usage = u;
    } catch {
      this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    }
  }

  /* ---------------- models ---------------- */

  async listModels() {
    await loadPi();
    const out = [];
    try {
      const avail = await this.modelRuntime.getAvailable();
      for (const m of avail) {
        out.push({
          provider: m.provider,
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.contextWindow,
          reasoning: !!m.reasoning,
        });
      }
    } catch (e) {
      out.push({ error: String(e?.message || e) });
    }
    return out;
  }

  async setModel(provider, id) {
    const m = this.modelRuntime.getModel(provider, id);
    if (!m) throw new Error(`Model not found: ${provider}/${id}`);
    await this.session.setModel(m);
    this.store.set("modelKey", `${provider}/${id}`);
    this.pushState();
    return this.publicState();
  }

  /* ---------------- auth / login（与 pi CLI 共享 ~/.pi/agent/auth.json） ---------------- */

  async authProviders() {
    await loadPi();
    const mr = this.modelRuntime;
    if (!mr) throw new Error("Model runtime not ready");
    const provs = mr.getProviders();
    const arr = Array.isArray(provs) ? provs : Object.values(provs || {});
    const out = [];
    for (const p of arr) {
      const id = p.id || p.providerId;
      if (!id) continue;
      const auth = p.auth || {};
      const canOAuth = !!auth.oauth?.login;
      const canApiKey = !!auth.apiKey?.login;
      let status = { configured: false };
      try { status = (await mr.getProviderAuthStatus(id)) || status; } catch {}
      if (!canOAuth && !canApiKey && !status.configured) continue; // ambient-only，无可配置项
      let usingSub = false;
      try { usingSub = mr.isUsingSubscription(id) === true; } catch {}
      out.push({
        id,
        name: p.name || id,
        canOAuth,
        canApiKey,
        subscription: canOAuth && auth.oauth?.isSubscription === true,
        oauthName: auth.oauth?.name || "",
        apiKeyName: auth.apiKey?.name || "",
        configured: !!status.configured,
        source: status.source || "",
        usingSub,
      });
    }
    out.sort((a, b) => (b.configured - a.configured) || a.name.localeCompare(b.name));
    return out;
  }

  /** 启动登录流程：OAuth/ApiKey 的提示与事件通过 pi:event（type:"auth_event"）推给渲染层 */
  authLogin(providerId, type) {
    return this._authRun(providerId, type === "oauth" ? "oauth" : "api_key");
  }

  async _authRun(providerId, type) {
    await loadPi();
    const mr = this.modelRuntime;
    if (!mr) throw new Error("Model runtime not ready");
    console.log(`[auth] login start: ${providerId} (${type})`);
    this._authAbort = new AbortController();
    const interaction = {
      signal: this._authAbort.signal,
      prompt: (p) => new Promise((resolve, reject) => {
        console.log(`[auth] prompt: ${providerId} <- ${p.type} ${(p.message || "").slice(0, 60)}`);
        this._authPromptResolve = { resolve, reject };
        this.emit("pi:event", { event: { type: "auth_event", phase: "prompt", providerId, prompt: p } });
      }),
      notify: (ev) => {
        console.log(`[auth] notify: ${providerId} -> ${ev.type}`);
        this.emit("pi:event", { event: { type: "auth_event", phase: "notify", providerId, event: ev } });
      },
    };
    try {
      const cred = await mr.login(providerId, type, interaction);
      console.log(`[auth] done: ${providerId} (${cred?.type || type})`);
      this.emit("pi:event", { event: { type: "auth_event", phase: "done", providerId, credentialType: cred?.type || type } });
      this.pushState();
      return { providerId, type: cred?.type || type };
    } catch (e) {
      console.log(`[auth] error: ${providerId} ->`, e?.message || e);
      this.emit("pi:event", { event: { type: "auth_event", phase: "error", providerId, error: String(e?.message || e) } });
      throw e;
    } finally {
      this._authPromptResolve = null;
      this._authAbort = null;
    }
  }

  authPromptRespond(value) {
    const p = this._authPromptResolve;
    if (!p) throw new Error("没有等待中的登录输入");
    this._authPromptResolve = null;
    p.resolve(value);
    return true;
  }

  authCancel() {
    const p = this._authPromptResolve;
    if (p) { this._authPromptResolve = null; p.reject(new Error("已取消")); }
    this._authAbort?.abort();
    this._authAbort = null;
    return true;
  }

  async authLogout(providerId) {
    await loadPi();
    await this.modelRuntime.logout(providerId);
    this.pushState();
    return true;
  }

  setThinkingLevel(level) {
    this.session?.setThinkingLevel(level);
    this.store.set("thinkingLevel", level);
    this.pushState();
    return this.publicState();
  }

  /* ---------------- prompting ---------------- */

  async prompt(text, opts = {}) {
    if (!this.session) throw new Error("Session not ready");
    await this.session.prompt(text, opts);
    return this.publicState();
  }

  async steer(text) {
    await this.session?.steer(text);
    return this.publicState();
  }

  async followUp(text) {
    await this.session?.followUp(text);
    return this.publicState();
  }

  async abort() {
    await this.session?.abort();
    return this.publicState();
  }

  async compact(customInstructions) {
    if (!this.session) throw new Error("Session not ready");
    const res = await this.session.compact(customInstructions);
    return { ok: true, summary: String(res?.summary || "").slice(0, 400) };
  }

  /* ---------------- sessions ---------------- */

  async listSessions() {
    const { SessionManager } = await loadPi();
    const out = [];
    try {
      // NOTE: listAll() returns [] in pi 0.84.x — use list(), which returns
      // {path,id,cwd,name,created,modified,messageCount,firstMessage,...}
      const all = await SessionManager.list(this.cwd);
      for (const s of Array.isArray(all) ? all : []) {
        const f = s.path || s.file || s.sessionFile || "";
        const mc = s.messageCount ?? null;
        // 空会话（0 条消息）不进列表：新会话在发出第一条消息前不显示，
        // 否则每次删除当前会话都会冒出一个删不掉的“新会话”
        if (f && mc === 0) continue;
        if (f && mc == null && !fs.existsSync(f)) continue; // 失效条目（文件已不存在）
        out.push({
          file: f,
          id: s.id || "",
          name: s.name || s.firstMessage || "",
          modified: s.modified || s.mtime || null,
          messageCount: mc,
        });
      }
    } catch {}
    // 当前会话若尚未落盘但已有消息，目录里扫不到 —— 手动补进列表
    // （空会话不补：新建/删除后的空会话不显示，避免“总出现一个新会话”）
    try {
      const sf = this.session?.sessionFile;
      const st = this.publicState();
      if (sf && (st.messageCount ?? 0) > 0 && !out.some((s) => PiBridge.normPath(s.file) === PiBridge.normPath(sf))) {
        out.unshift({
          file: sf,
          id: st.sessionId || "",
          name: "新会话",
          modified: Date.now(),
          messageCount: st.messageCount ?? 0,
        });
      }
    } catch {}
    out.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
    return out.slice(0, 40);
  }

  /**
   * 模型用量统计：扫描全部会话 jsonl，聚合近 N 天的 tokens / 花费。
   * 数据源与 pi CLI 完全一致（agent 目录 sessions 下每个会话文件里
   * assistant 消息的 usage 字段），无需额外记录。
   */
  async usageSummary(days = 30) {
    const since = Date.now() - days * 86400000;
    const { getAgentDir } = await loadPi();
    const root = path.join(getAgentDir(), "sessions");
    const byModel = new Map();   // provider/model -> 聚合
    const byDay = new Map();     // YYYY-MM-DD -> 聚合
    const byProject = new Map(); // cwd -> 聚合
    let sessions = 0;
    const emptyAgg = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
    const add = (map, key, u) => {
      const a = map.get(key) || emptyAgg();
      a.calls++; a.input += u.input || 0; a.output += u.output || 0;
      a.cacheRead += u.cacheRead || 0; a.cacheWrite += u.cacheWrite || 0;
      a.totalTokens += u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      a.cost += u.cost?.total || 0;
      map.set(key, a);
    };
    const scan = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { scan(full); continue; }
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        let text = "";
        try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
        const lines = text.split("\n");
        let cwd = "";
        let counted = false;
        for (const line of lines) {
          if (!line || line[0] !== "{") continue;
          // 快速预筛：不含 usage 的行直接跳过（session/model_change 等头部行除外）
          const isSessionHead = line.includes('"type":"session"');
          if (!isSessionHead && !line.includes('"usage"')) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (isSessionHead) { cwd = obj.cwd || cwd; continue; }
          const m = obj.message;
          if (m?.role !== "assistant" || !m.usage) continue;
          const ts = Date.parse(obj.timestamp || "");
          if (!Number.isFinite(ts) || ts < since) continue;
          if (!counted) { sessions++; counted = true; }
          add(byModel, `${m.provider || "?"}/${m.model || "?"}`, m.usage);
          add(byDay, String(obj.timestamp || "").slice(0, 10) || "?", m.usage);
          add(byProject, cwd || "未知项目", m.usage);
        }
      }
    };
    scan(root);
    const r4 = (n) => Math.round(n * 10000) / 10000;
    const models = [...byModel.entries()].map(([key, a]) => ({ key, ...a, cost: r4(a.cost) }))
      .sort((x, y) => y.totalTokens - x.totalTokens);
    const daily = [...byDay.entries()].map(([date, a]) => ({ date, ...a, cost: r4(a.cost) }))
      .sort((x, y) => x.date.localeCompare(y.date));
    const projects = [...byProject.entries()].map(([cwd, a]) => ({ cwd, ...a, cost: r4(a.cost) }))
      .sort((x, y) => y.totalTokens - x.totalTokens).slice(0, 8);
    const totals = [...byModel.values()].reduce((s, a) => ({
      calls: s.calls + a.calls, input: s.input + a.input, output: s.output + a.output,
      cacheRead: s.cacheRead + a.cacheRead, cacheWrite: s.cacheWrite + a.cacheWrite,
      totalTokens: s.totalTokens + a.totalTokens, cost: s.cost + a.cost,
    }), emptyAgg());
    totals.cost = r4(totals.cost);
    return { days, sessions, totals, models, daily, projects };
  }

  /* ---------------- 模型剩余额度（多制度） ----------------
   * points  积分制（AutoClaw）：agent-assetmgr 钱包接口 total_balance
   * balance 余额制（DeepSeek / Moonshot / OpenRouter / MiniMax / OpenAI 赠金）：官方余额接口，货币金额
   * windows 订阅制（OpenAI Codex / Z.AI·智谱 GLM Coding）：5h + 周/7天滚动窗口百分比
   * 未接入的 provider 显示占位提示（不伪装百分比）
   */
  #quotaCache = new Map(); // provider → { ts, data }

  #quotaKindFor(provider) {
    if (provider === "autoclaw") return "points";
    if (["openai-codex", "zai", "zai-coding-cn"].includes(provider)) return "windows";
    if (["deepseek", "moonshotai", "moonshotai-cn", "openrouter", "minimax", "minimax-cn", "openai"].includes(provider)) return "balance";
    return "context"; // 未接入额度的 provider：显示占位提示
  }

  /** 读取 pi 凭据（~/.pi/agent/auth.json），只取指定 provider 的字段 */
  #piCredential(providerId) {
    const file = path.join(os.homedir(), ".pi", "agent", "auth.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j?.[providerId] || null;
  }

  /** chatgpt.com 需走系统代理；国内端点直连 */
  async #proxiedFetch(url, init) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || "";
    if (proxy) {
      try {
        const undici = await import("undici");
        if (undici?.ProxyAgent) return fetch(url, { ...init, dispatcher: new undici.ProxyAgent(proxy) });
      } catch {}
    }
    return fetch(url, init);
  }

  /** AutoClaw 桌面端令牌：request-headers.json 由桌面端周期性重写，读前先取最新 */
  #autoclawToken() {
    const file = path.join(os.homedir(), ".openclaw-autoclaw", "request-headers.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    let t = String(j?.headers?.["X-Authorization"] || "").trim();
    if (!t) throw new Error("AutoClaw 令牌不存在（桌面端未登录？）");
    return t.startsWith("Bearer ") ? t : `Bearer ${t}`;
  }

  /** AutoClaw 控制台接口签名：X-Auth-Sign = md5(appid & 秒级时间戳 & appkey) */
  #autoclawHeaders() {
    const APP_ID = "100003";
    const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      "Content-Type": "application/json",
      Accept: "*/*",
      "X-Version": "1.17.9",
      "X-Tm": "win",
      "X-Product": "autoclaw",
      "X-Channel": "official",
      "X-Lang": "zh-CN",
      "X-Auth-Appid": APP_ID,
      "X-Auth-TimeStamp": ts,
      "X-Auth-Sign": crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex"),
      "X-Trace-Id": crypto.randomUUID(),
      authorization: this.#autoclawToken(),
    };
  }

  async #quotaAutoclaw() {
    const base = "https://autoglm-acceleration-api.zhipuai.cn";
    const headers = this.#autoclawHeaders();
    const r = await fetch(`${base}/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`, { headers, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    if (j?.code !== 0 || !j?.data) throw new Error(j?.msg || `wallets HTTP ${r.status}`);
    return { kind: "points", label: "积分", value: Number(j.data.total_balance) || 0 };
  }

  async #quotaDeepSeek() {
    const cred = this.#piCredential("deepseek");
    if (!cred?.key) throw new Error("DeepSeek 未配置 API Key");
    const r = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${cred.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => null);
    const info = j?.balance_infos?.[0];
    if (!info) throw new Error(j?.error?.message || `balance HTTP ${r.status}`);
    return { kind: "balance", label: "余额", value: Number(info.total_balance) || 0, currency: info.currency || "CNY" };
  }

  async #quotaCodex() {
    const cred = this.#piCredential("openai-codex");
    if (!cred?.access || !cred?.accountId) throw new Error("OpenAI Codex 未登录");
    const r = await this.#proxiedFetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${cred.access}`,
        "ChatGPT-Account-Id": cred.accountId,
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json().catch(() => null);
    const rl = j?.rate_limit || j?.rate_limits || {};
    const mk = (w, fallbackSeconds) => {
      if (!w) return null;
      const seconds = Number(w.limit_window_seconds) || fallbackSeconds;
      const hours = Math.round(seconds / 3600);
      const label = hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
      const used = Number(w.used_percent);
      const remaining = Number.isFinite(used) ? Math.max(0, Math.min(1, 1 - used / 100)) : 1;
      return { label, remaining, resetAt: Number(w.reset_at) || 0 };
    };
    const windows = [mk(rl.primary_window, 5 * 3600), mk(rl.secondary_window, 7 * 24 * 3600)].filter(Boolean);
    if (!windows.length) throw new Error(`usage HTTP ${r.status}`);
    return { kind: "windows", windows };
  }

  /** Z.AI / 智谱 GLM Coding 订阅：token 窗口用量百分比（认证为裸 token，无 Bearer 前缀） */
  async #quotaZai(provider) {
    const cred = this.#piCredential(provider);
    if (!cred?.key) throw new Error(provider === "zai" ? "Z.AI 未配置 API Key" : "智谱 GLM Coding 未配置 API Key");
    const base = provider === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
    const r = await fetch(`${base}/api/monitor/usage/quota/limit`, {
      headers: { Authorization: cred.key, "Content-Type": "application/json", "Accept-Language": "en-US,en" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`quota HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    const rows = Array.isArray(j?.limits) ? j.limits : [];
    const windows = [];
    for (const lim of rows) {
      if (lim?.type !== "TOKENS_LIMIT") continue; // TIME_LIMIT 是 MCP 调用次数，与对话额度无关
      const used = Number(lim.percentage);
      if (!Number.isFinite(used)) continue;
      const isWeek = Number(lim.unit) === 6 && Number(lim.number) === 1;
      windows.push({
        label: isWeek ? "周" : "5h",
        remaining: Math.max(0, Math.min(1, 1 - used / 100)),
        resetAt: Number(lim.nextResetTime) ? Number(lim.nextResetTime) / 1000 : 0,
      });
    }
    if (!windows.length) throw new Error("quota 数据缺失");
    return { kind: "windows", windows };
  }

  /** Moonshot 平台预付余额：.ai 全球站 USD / .cn 国内站 CNY，含代金券 */
  async #quotaMoonshot(provider, base, currency) {
    const cred = this.#piCredential(provider);
    if (!cred?.key) throw new Error("Moonshot 未配置 API Key");
    const r = await this.#proxiedFetch(`${base}/v1/users/me/balance`, {
      headers: { Authorization: `Bearer ${cred.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`balance HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    const d = j?.data;
    const v = Number(d?.available_balance ?? d?.cash_balance);
    if (!d || !Number.isFinite(v)) throw new Error("balance 数据缺失");
    return { kind: "balance", label: "余额", value: Math.max(0, v), currency, voucher: Number(d?.voucher_balance) || 0 };
  }

  /** OpenRouter 预付信用：total_credits - total_usage，USD */
  async #quotaOpenrouter() {
    const cred = this.#piCredential("openrouter");
    if (!cred?.key) throw new Error("OpenRouter 未配置 API Key");
    const r = await this.#proxiedFetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${cred.key}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`credits HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    const total = Number(j?.data?.total_credits);
    if (!Number.isFinite(total)) throw new Error("credits 数据缺失");
    const used = Number(j?.data?.total_usage);
    return { kind: "balance", label: "余额", value: Math.max(0, total - (Number.isFinite(used) ? used : 0)), currency: "USD" };
  }

  /** 尽力而为接口：拿不到就返回 null（渲染层显示 —，不显示错误态） */
  async #quotaOpenaiPlatform() {
    try {
      const cred = this.#piCredential("openai");
      if (!cred?.key) return null;
      const r = await this.#proxiedFetch("https://api.openai.com/v1/dashboard/billing/credit_grants", {
        headers: { Authorization: `Bearer ${cred.key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      const v = Number(j?.total_available);
      if (!Number.isFinite(v)) return null;
      return { kind: "balance", label: "赠金", value: Math.max(0, v), currency: "USD" };
    } catch { return null; }
  }

  async #quotaMinimax(provider) {
    try {
      const cred = this.#piCredential(provider);
      if (!cred?.key) return null;
      const base = provider === "minimax-cn" ? "https://api.minimaxi.com" : "https://api.minimax.io";
      const r = await fetch(`${base}/v1/get_balance?key=${encodeURIComponent(cred.key)}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (j?.base_resp?.status_code !== 0) return null;
      const v = Number(j?.balance);
      if (!Number.isFinite(v)) return null;
      return { kind: "balance", label: "余额", value: Math.max(0, v), currency: j?.currency || (provider === "minimax-cn" ? "CNY" : "USD") };
    } catch { return null; }
  }

  /** 当前 provider 的剩余额度；60s 内存缓存，失败时沿用上次数据 */
  async modelQuota(provider) {
    const kind = this.#quotaKindFor(provider);
    if (kind === "context") return { kind: "context" };
    const hit = this.#quotaCache.get(provider);
    if (hit && Date.now() - hit.ts < 60_000) return hit.data;
    try {
      let data = null;
      switch (provider) {
        case "autoclaw": data = await this.#quotaAutoclaw(); break;
        case "deepseek": data = await this.#quotaDeepSeek(); break;
        case "openai-codex": data = await this.#quotaCodex(); break;
        case "zai": case "zai-coding-cn": data = await this.#quotaZai(provider); break;
        case "moonshotai": data = await this.#quotaMoonshot(provider, "https://api.moonshot.ai", "USD"); break;
        case "moonshotai-cn": data = await this.#quotaMoonshot(provider, "https://api.moonshot.cn", "CNY"); break;
        case "openrouter": data = await this.#quotaOpenrouter(); break;
        case "minimax": case "minimax-cn": data = await this.#quotaMinimax(provider); break;
        case "openai": data = await this.#quotaOpenaiPlatform(); break;
      }
      if (data) {
        this.#quotaCache.set(provider, { ts: Date.now(), data });
        return data;
      }
      // 尽力而为接口无数据：按「无额度信息」处理
      return { kind: "context" };
    } catch {}
    return hit?.data || { kind, error: true };
  }

  async openSession(file) {
    await this.runtime.switchSession(file);
    this._bindSession();
    await this.restoreModel();
    this._noteSession();
    this._recomputeUsageFromSession();
    this.pushState();
    return this.publicState();
  }

  async newSession() {
    await this.runtime.newSession();
    this._bindSession();
    await this.restoreModel();
    this._noteSession();
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    this.pushState();
    return this.publicState();
  }

  /** 删除会话记录文件；若删除的是当前会话，先切到新会话再删文件 */
  async deleteSession(file) {
    const abs = path.resolve(file);
    if (!/\.jsonl$/i.test(abs)) throw new Error("不是会话记录文件");
    let switched = false;
    const current = this.session?.sessionFile;
    const isCurrent = current && path.resolve(current) === abs;
    if (!fs.existsSync(abs)) {
      // 文件不存在：若是当前空会话（尚未落盘的幽灵条目），视为“丢弃”直接开新会话
      if (!isCurrent) throw new Error("会话记录不存在");
      if (this.session?.isStreaming) throw new Error("任务进行中，先中止再删除");
      await this.runtime.newSession();
      this._bindSession();
      this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      this.pushState();
      return { switched: true };
    }
    if (isCurrent) {
      if (this.session?.isStreaming) throw new Error("任务进行中，先中止再删除");
      await this.runtime.newSession();
      this._bindSession();
      this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      switched = true;
    }
    fs.rmSync(abs, { force: true });
    this.pushState();
    return { switched };
  }

  /* ---------------- environment ---------------- */

  async chooseProject(currentPath) {
    return { cwd: "dialog:chooseProject", currentPath }; // handled by main via dialog
  }

  snapshotMessages() {
    // shallow, UI-safe copy of history for restoring chat view
    // 包含 thinking / toolCall / toolResult，恢复后思考与工具调用记录才能完整回放
    const msgs = this.session?.messages || [];
    return msgs.map((m) => ({
      role: m.role,
      toolCallId: m.toolCallId || null,
      toolName: m.toolName || null,
      isError: !!m.isError,
      timestamp: m.timestamp || null,
      content: typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : Array.isArray(m.content)
          ? m.content.map((c) => {
              if (!c) return null;
              if (c.type === "text") return { type: "text", text: c.text };
              if (c.type === "image") return { type: "image" };
              if (c.type === "thinking") return { type: "thinking", thinking: c.thinking || "" };
              if (c.type === "toolCall") return { type: "toolCall", id: c.id, name: c.name, arguments: c.arguments };
              return null;
            }).filter(Boolean)
          : [],
      usage: m.usage || null,
    }));
  }

  /* pi-parity resource discovery: skills / prompts / extensions */
  listResources() {
    const out = { skills: [], prompts: [], extensions: [] };
    try {
      const loader =
        this.runtime?.services?.resourceLoader || this.services?.resourceLoader;
      if (loader) {
        const sk = loader.getSkills?.() || {};
        out.skills = (sk.skills || []).map((s) => ({ name: s.name, description: s.description }));
        const pr = loader.getPrompts?.() || {};
        out.prompts = (pr.prompts || []).map((p) => ({ name: p.name, description: p.description }));
      }
      const disabled = new Set(this.store.data.disabledExtensions || []);
      let all = this._allExtensions || [];
      if (!all.length && loader) {
        try {
          all = (loader.getExtensions().extensions || []).map((x) => ({
            name: path.basename(x.path || "") || "extension",
            path: x.path || "",
          }));
        } catch {}
      }
      out.extensions = all.map((x) => ({ ...x, disabled: disabled.has(x.path) }));
    } catch {}
    return out;
  }

  /* 扩展开关：写入禁用名单并重建会话（保留当前会话记录） */
  async setExtensionEnabled(extPath, enabled) {
    const list = new Set(this.store.data.disabledExtensions || []);
    if (enabled) list.delete(extPath);
    else list.add(extPath);
    this.store.set("disabledExtensions", [...list]);
    const sf = this.session?.sessionFile;
    if (sf && this.runtime) {
      try {
        await this.runtime.switchSession(sf);
        this._bindSession();
        await this.restoreModel();
        this._recomputeUsageFromSession();
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    }
    this.pushState();
    return this.listResources();
  }

  async dispose() {
    try {
      this.unsubscribe?.();
      this.session?.dispose?.();
    } catch {}
  }
}
