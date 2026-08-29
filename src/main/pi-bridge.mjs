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
      const services = await createAgentSessionServices({ cwd });
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
      const all = await SessionManager.listAll(this.cwd);
      for (const s of Array.isArray(all) ? all : []) {
        out.push({
          file: s.path || s.file || s.sessionFile || "",
          id: s.id || "",
          name: s.name || s.displayName || "",
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

  /* pi-parity resource discovery: skills / prompts / extensions / context files */
  listResources() {
    const out = { skills: [], prompts: [], extensions: [], contextFiles: [] };
    try {
      const loader =
        this.runtime?.services?.resourceLoader ||
        this.services?.resourceLoader ||
        this.runtime?.services?.resources ||
        this.services?.resources;
      const safe = (fn) => {
        try { return fn?.() || []; } catch { return []; }
      };
      if (loader) {
        out.skills = safe(loader.getSkills).map((s) => ({ name: s.name, description: s.description }));
        out.prompts = safe(loader.getPrompts).map((p) => ({ name: p.name, description: p.description }));
        out.extensions = safe(loader.getExtensions).map((x) => ({ name: x.name || x.id || "extension" }));
        out.contextFiles = safe(() => loader.getAgentsFiles?.().agentsFiles).map((f) => f?.path || "").filter(Boolean);
      }
    } catch {}
    return out;
  }

  async dispose() {
    try {
      this.unsubscribe?.();
      this.session?.dispose?.();
    } catch {}
  }
}
