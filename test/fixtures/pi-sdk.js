// Offline SDK fixture: session persistence and events only, never model inference.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const models = ['a', 'b'].map(id => ({ provider: 'fixture', id, name: id, contextWindow: 10000 }));
const agentDir = () => process.env.PI_CODING_AGENT_DIR;

class SessionManager {
  constructor(cwd, file, id = crypto.randomUUID(), messages = [], model = models[0]) {
    Object.assign(this, { cwd, file, id, messages, model });
  }
  static create(cwd, dir) {
    const id = crypto.randomUUID();
    return new SessionManager(cwd, path.join(dir || path.join(agentDir(), 'sessions'), `fixture_${id}.jsonl`), id);
  }
  static open(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new SessionManager(data.cwd, file, data.id, data.messages, data.model);
  }
  static async list(cwd, dir) {
    dir ||= path.join(agentDir(), 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => {
      const file = path.join(dir, name), sm = SessionManager.open(file);
      return { path: file, id: sm.id, cwd: sm.cwd, messageCount: sm.messages.length,
        firstMessage: sm.messages[0]?.content?.[0]?.text || '', modified: fs.statSync(file).mtimeMs };
    });
  }
  getCwd() { return this.cwd; }
  getSessionId() { return this.id; }
  getSessionFile() { return this.file; }
  appendMessage(message) { this.messages.push(message); this.save(); }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this));
  }
}

function sessionFor(sm) {
  const listeners = new Set();
  const state = { messages: [...sm.messages], model: sm.model };
  return {
    sessionManager: sm, sessionFile: sm.file, sessionId: sm.id,
    agent: { state }, isStreaming: false,
    get messages() { return state.messages; },
    get model() { return state.model; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
    async setModel(model) { state.model = model; sm.model = model; sm.save(); },
    setThinkingLevel(level) { this.thinkingLevel = level; },
    async prompt() { throw new Error('The offline SDK fixture does not run inference'); },
    async abort() { this.isStreaming = false; },
  };
}

exports.initTheme = () => {};
exports.getAgentDir = agentDir;
exports.SessionManager = SessionManager;
exports.ModelRuntime = { create: async () => ({
  getModel: (provider, id) => models.find(model => model.provider === provider && model.id === id),
  getAvailable: async () => models, getAvailableSnapshot: () => models,
  getProviders: () => [], refresh: async () => {}, checkAuth: async () => true,
}) };
exports.createAgentSessionRuntime = async (_factory, options) => {
  const runtime = {
    session: sessionFor(options.sessionManager),
    async switchSession(file, opts) {
      const sm = SessionManager.open(file);
      if (opts?.cwdOverride) sm.cwd = opts.cwdOverride;
      this.session = sessionFor(sm);
    },
    async dispose() { await this.session.abort(); },
  };
  return runtime;
};
