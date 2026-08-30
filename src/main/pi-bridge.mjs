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
        this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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
        out.push({
          file: s.path || s.file || s.sessionFile || "",
          id: s.id || "",
          name: s.name || s.firstMessage || "",
          modified: s.modified || s.mtime || null,
          messageCount: s.messageCount ?? null,
        });
      }
    } catch {}
    // 当前会话若尚未落盘（没发过消息），目录里扫不到 —— 手动补进列表，否则新建会话不显示
    try {
      const sf = this.session?.sessionFile;
      if (sf && !out.some((s) => PiBridge.normPath(s.file) === PiBridge.normPath(sf))) {
        const st = this.publicState();
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

  async openSession(file) {
    await this.runtime.switchSession(file);
    this._bindSession();
    await this.restoreModel();
    this._noteSession();
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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
    if (!fs.existsSync(abs)) throw new Error("会话记录不存在");
    let switched = false;
    const current = this.session?.sessionFile;
    if (current && path.resolve(current) === abs) {
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
    const msgs = this.session?.messages || [];
    return msgs.map((m) => ({
      role: m.role,
      content: typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : Array.isArray(m.content)
          ? m.content.filter((c) => c && (c.type === "text" || c.type === "image")).map((c) =>
              c.type === "text" ? { type: "text", text: c.text } : { type: "image" })
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
        this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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
