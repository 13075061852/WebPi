import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VIDEO_PROVIDERS, validateVideoOptions, videoSpec, videoModelDefaults } from './video-providers.mjs';

export function validateVideoNetwork(network = 'system') {
  if (!['system', 'direct', 'proxy'].includes(network)) throw Error('无效的连接方式');
  return network;
}

export function writeVideoJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export class VideoSettings {
  constructor(file, { seal, unseal }) { Object.assign(this, { file, seal, unseal }); }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, provider: 'minimax', enabled: true, configs: {} };
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value.version !== 1 || !Object.hasOwn(VIDEO_PROVIDERS, value.provider) || !value.configs || typeof value.configs !== 'object' || Array.isArray(value.configs)) throw Error();
      // The default provider's saved configuration is the single source of truth.
      // Older files may contain a defaultModel left behind by a later model save.
      value.defaultModel = value.configs[value.provider]?.model || videoSpec(value.provider).defaults.model;
      return value;
    } catch { throw Error('视频配置文件无法读取，请检查 halo-video.json'); }
  }
  publicConfig(provider, state = this.read()) {
    videoSpec(provider);
    const entry = state.configs[provider] || {};
    return { provider, ...validateVideoOptions(provider, entry), network: validateVideoNetwork(entry.network), hasApiKey: Boolean(entry.encryptedApiKey) };
  }
  publicState() {
    const state = this.read();
    const current = this.publicConfig(state.provider, state);
    return { ...current, defaultModel: current.model, enabled: state.enabled, providers: Object.values(VIDEO_PROVIDERS),
      configs: Object.fromEntries(Object.keys(VIDEO_PROVIDERS).map(id => [id, this.publicConfig(id, state)])) };
  }
  save(input) {
    if (!input || typeof input !== 'object' || !Object.hasOwn(VIDEO_PROVIDERS, input.provider)) throw Error('无效的视频配置');
    const state = this.read(), previous = state.configs[input.provider] || {};
    if (input.clearKey === true) {
      state.configs[input.provider] = { ...previous };
      delete state.configs[input.provider].encryptedApiKey;
      writeVideoJSON(this.file, state);
      return this.publicState();
    }
    const base = input.model && input.model !== previous.model ? videoModelDefaults(input.provider, input.model) : previous;
    const options = validateVideoOptions(input.provider, { ...base, ...input });
    const network = validateVideoNetwork(input.network ?? previous.network);
    let encryptedApiKey = previous.encryptedApiKey;
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw Error('API Key 格式无效');
    if (input.apiKey?.trim()) {
      const key = input.apiKey.trim();
      if (key.length > 8192 || /\s/.test(key)) throw Error('API Key 格式无效');
      encryptedApiKey = this.seal(key);
      if (!encryptedApiKey) throw Error('系统密钥加密不可用，未保存 API Key');
    }
    if (input.setDefault === true) {
      if (!encryptedApiKey) throw Error('请先配置 API Key');
      state.provider = input.provider;
    }
    if (state.provider === input.provider) state.defaultModel = options.model;
    state.enabled = input.enabled !== false;
    state.configs[input.provider] = { ...options, network, ...(encryptedApiKey ? { encryptedApiKey } : {}) };
    writeVideoJSON(this.file, state);
    return this.publicState();
  }
  credential(provider = this.read().provider) {
    videoSpec(provider);
    const value = this.read().configs[provider]?.encryptedApiKey;
    if (!value) throw Error('请先在设置 → 视频模型中保存 API Key');
    const key = this.unseal(value);
    if (!key) throw Error('视频 API Key 无法解密，请重新配置');
    return key;
  }
}
