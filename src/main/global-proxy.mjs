import http from 'node:http';
import https from 'node:https';
import { Agent, EnvHttpProxyAgent, install, setGlobalDispatcher } from 'undici';

const bypass = 'localhost,127.0.0.1,::1';
const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy',
  'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NOPROXY'];

export function normalizeProxy(value = {}) {
  if (!['direct', 'proxy'].includes(value.mode)) throw Error('请选择直连或代理');
  const port = String(value.port ?? '').trim();
  if (value.mode === 'proxy' && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw Error('代理端口必须是 1–65535 的整数');
  }
  return { mode: value.mode, port: /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 ? Number(port) : 7890 };
}

export function applyNodeProxy(config, env = process.env) {
  const address = `http://127.0.0.1:${config.port}`;
  for (const key of keys) delete env[key];
  const proxyEnv = config.mode === 'proxy' ? { HTTP_PROXY: address, HTTPS_PROXY: address, NO_PROXY: bypass } : {};
  Object.assign(env, proxyEnv, { HALO_PROXY_MODE: config.mode, NODE_USE_ENV_PROXY: '1' });
  if (config.mode === 'proxy') Object.assign(env, { ALL_PROXY: address, npm_config_proxy: address, npm_config_https_proxy: address, npm_config_noproxy: bypass });
  // Fresh agents also remove inherited proxy settings when returning to direct.
  const previousHttp = http.globalAgent, previousHttps = https.globalAgent;
  http.globalAgent = new http.Agent({ keepAlive: true, proxyEnv });
  https.globalAgent = new https.Agent({ keepAlive: true, proxyEnv });
  const dispatcher = config.mode === 'proxy'
    ? new EnvHttpProxyAgent({ httpProxy: address, httpsProxy: address, noProxy: bypass }) : new Agent();
  setGlobalDispatcher(dispatcher);
  install();
  // Do not interrupt requests already using the previous agents.
  previousHttp.keepAlive = false;
  previousHttps.keepAlive = false;
  return dispatcher;
}

export class GlobalProxy {
  constructor(store, { applyNode = applyNodeProxy, system } = {}) {
    this.store = store;
    this.system = system;
    this.applyNode = applyNode;
    this.sessions = new Set();
    this.tail = Promise.resolve();
    try { this.config = normalizeProxy(store.data.globalProxy || { mode:'direct', port:7890 }); }
    catch { this.config = { mode:'direct', port:7890 }; }
    this.dispatcher = applyNode(this.config);
  }
  state() { return { ...this.config }; }
  async read() {
    await this.tail.catch(() => {});
    return { ...this.state(), ...(this.system ? { system:await this.system.read() } : {}) };
  }
  async applySession(session, config = this.config) {
    await session.setProxy(config.mode === 'proxy'
      ? { mode:'fixed_servers', proxyRules:`http://127.0.0.1:${config.port}`, proxyBypassRules:'localhost;127.0.0.1;[::1]' }
      : { mode:'direct' });
    await session.closeAllConnections();
  }
  addSession(session) {
    this.sessions.add(session);
    return this.tail.catch(() => {}).then(() => this.applySession(session));
  }
  set(value) {
    const next = normalizeProxy(value);
    const work = this.tail.catch(() => {}).then(async () => {
      const previous = this.config;
      const snapshot = this.system ? await this.system.read() : undefined;
      const old = this.dispatcher;
      let dispatcher, actual;
      try {
        if (this.system) actual = await this.system.apply(next);
        const results = await Promise.allSettled([...this.sessions].map(session => this.applySession(session, next)));
        if (results.some(result => result.status === 'rejected')) throw Error('代理切换失败，请重试');
        dispatcher = this.applyNode(next);
        await this.store.set('globalProxy', next);
      } catch (error) {
        const rollback = await Promise.allSettled([
          ...[...this.sessions].map(session => this.applySession(session, previous)),
          ...(this.system ? [this.system.restore(snapshot)] : []),
        ]);
        try { this.dispatcher = this.applyNode(previous); } catch { rollback.push({status:'rejected'}); }
        void dispatcher?.close().catch(() => {});
        void old?.close().catch(() => {});
        if (rollback.some(item => item.status === 'rejected')) throw Error(error.message + '；还原未完成，请检查 Windows 系统代理设置');
        throw error;
      }
      this.dispatcher = dispatcher;
      this.config = next;
      void old?.close().catch(() => {});
      return { ...this.state(), ...(actual ? { system:actual } : {}) };
    });
    this.tail = work;
    return work;
  }
}
