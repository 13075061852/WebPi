import { EnvHttpProxyAgent, setGlobalDispatcher, install } from 'undici';

// The Pi CLI sets up its fetch dispatcher in its CLI entrypoint. Importing the
// SDK does not run that entrypoint, so Halo must do this in the packaged app too.
export function configureEnvironmentProxy(env = process.env) {
  const read = name => (env[name.toLowerCase()] ?? env[name] ?? '').trim();
  const allProxy = read('ALL_PROXY');
  const httpProxy = read('HTTP_PROXY') || allProxy;
  const httpsProxy = read('HTTPS_PROXY') || allProxy || httpProxy;
  if (!httpProxy && !httpsProxy) return null;

  for (const proxy of [httpProxy, httpsProxy].filter(Boolean)) {
    let url;
    try { url = new URL(proxy); } catch {}
    if (!url || !['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol)) {
      // Never include the value: a proxy URL can contain a password.
      throw new Error('代理环境变量格式无效，请使用完整的 HTTP、HTTPS 或 SOCKS5 代理地址');
    }
  }
  const dispatcher = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: read('NO_PROXY') });
  setGlobalDispatcher(dispatcher);
  // Keep fetch/Response and the dispatcher on the same undici implementation,
  // as Pi CLI does (notably for compressed JSON responses on newer Node builds).
  install();
  return dispatcher;
}
