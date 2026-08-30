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
    if (cwd) this.cwd = cwd;
    if (!this.cwd) this.cwd = path.join(os.homedir(), "Desktop");
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
            return { ...base, extensions: base.extensions.filter((x) => !disabled.has(x.path)) };
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

    // restore last model / thinking if saved
    try {
      const saved = this.store.data;
      if (saved.modelKey && this.session && !this.session.model) {
        const [provider, ...rest] = saved.modelKey.split("/");
        const id = rest.join("/");
        const m = this.modelRuntime.getModel(provider, id);
        if (m) await this.session.setModel(m);
      }
      if (saved.thinkingLevel && this.session) {
        this.session.setThinkingLevel(saved.thinkingLevel);
      }
    } catch {}
  }

  _bindSession() {
    if (this.unsubscribe) this.unsubscribe();
    this.session = this.runtime.session;
    this.unsubscribe = this.session.subscribe((event) => {
      this._accountUsage(event);
      this.emit("pi:event", { sessionId: this.session?.sessionId, event });
      // A6: keep renderer state fresh at every meaningful boundary
      if (event?.type === "message_end" || event?.type === "agent_end" || event?.type === "agent_settled") {
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
    out.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
    return out.slice(0, 40);
  }

  async openSession(file) {
    await this.runtime.switchSession(file);
    this._bindSession();
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    this.pushState();
    return this.publicState();
  }

  async newSession() {
    await this.runtime.newSession();
    this._bindSession();
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
