import { Agent, EnvHttpProxyAgent } from 'undici';

let directDispatcher;
const proxyDispatchers = new Map();
export function videoDispatcher(network = 'system', env = process.env) {
  if (network === 'system') return undefined;
  if (network === 'direct') return directDispatcher ||= new Agent();
  if (network !== 'proxy') throw Error('无效的连接方式');
  const read = key => (env[key.toLowerCase()] ?? env[key] ?? '').trim();
  const httpProxy = read('HTTP_PROXY') || read('ALL_PROXY');
  const httpsProxy = read('HTTPS_PROXY') || read('ALL_PROXY') || httpProxy;
  if (!httpsProxy) throw Error('未配置全局代理，请设置 HTTPS_PROXY 后重启应用，或选择直连');
  const cacheKey = `${httpProxy}\n${httpsProxy}`;
  if (!proxyDispatchers.has(cacheKey)) {
    try { proxyDispatchers.set(cacheKey, new EnvHttpProxyAgent({ httpProxy: httpProxy || httpsProxy, httpsProxy, noProxy: '' })); }
    catch { throw Error('全局代理地址格式无效，请检查 HTTP_PROXY / HTTPS_PROXY'); }
  }
  return proxyDispatchers.get(cacheKey);
}

export const redactVideoError = (value, secrets = []) => {
  let text = String(value || '请求失败');
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length)) text = text.split(secret).join('[已隐藏]');
  return text.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://***@').slice(0, 600);
};

export class VideoHTTP {
  constructor({ fetchImpl = fetch, network = 'system' } = {}) { this.fetch = fetchImpl; this.network = network; }
  async raw(url, { key, headers = {}, body, method, signal, redirect = 'error', timeoutMs = 45000 } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw Error('视频接口必须使用 HTTPS');
    const dispatcher = videoDispatcher(this.network);
    const requestHeaders = { ...(typeof key === 'string' && key ? { Authorization: `Bearer ${key}` } : {}), ...headers };
    const form = body instanceof FormData;
    if (body !== undefined && !form) requestHeaders['Content-Type'] ||= 'application/json';
    try {
      return await this.fetch(target.href, { method: method || (body !== undefined ? 'POST' : 'GET'),
        ...(Object.keys(requestHeaders).length ? { headers: requestHeaders } : {}),
        ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
        redirect, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || error?.name || 'NETWORK_ERROR');
      const reasons = { ECONNREFUSED: '连接被拒绝，请检查代理是否启动及端口是否正确', ENOTFOUND: '域名解析失败', EAI_AGAIN: '域名解析超时',
        UND_ERR_CONNECT_TIMEOUT: '连接超时', TimeoutError: '请求超时', ECONNRESET: '连接被关闭，请检查代理或网络',
        CERT_HAS_EXPIRED: '证书已过期', UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书验证失败' };
      const failure = Error(signal?.aborted ? '已停止等待视频任务' : `${target.hostname}：${reasons[code] || '网络连接失败'}（${code}，${this.network === 'direct' ? '直连' : '全局代理配置'}）`);
      failure.code = code;
      throw failure;
    }
  }
  async request(url, options = {}) {
    const response = await this.raw(url, options);
    const secrets = [...(typeof options.key === 'string' ? [options.key] : Object.values(options.key || {})), ...Object.values(options.headers || {}).filter(value => typeof value === 'string')];
    let raw = '', size = 0;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw Error('响应过大');
        raw += decoder.decode(chunk, { stream: true });
      }
      raw += decoder.decode();
    } catch { throw Error('视频接口响应读取失败'); }
    let data;
    try { data = JSON.parse(raw); } catch {
      const error = Error(`${new URL(url).hostname}：HTTP ${response.status}，响应不是有效 JSON`);
      error.status = response.status; throw error;
    }
    if (!response.ok) {
      const reason = data?.error?.message || data?.message || data?.detail || data?.msg || data?.error || response.statusText;
      const error = Error(`${new URL(url).hostname}（HTTP ${response.status}）：${redactVideoError(typeof reason === 'object' ? JSON.stringify(reason) : reason, secrets)}`);
      error.status = response.status;
      error.data = JSON.parse(redactVideoErrorJSON(data, secrets));
      throw error;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error(`${new URL(url).hostname}：响应结构无效`);
    return data;
  }
}

function redactVideoErrorJSON(data, secrets) {
  return JSON.stringify(data, (_key, value) => typeof value === 'string' ? redactVideoError(value, secrets) : value);
}
