export const connectivityTargets = Object.freeze({
  google: 'https://www.google.com/',
  github: 'https://github.com/',
  youtube: 'https://www.youtube.com/',
  facebook: 'https://www.facebook.com/',
  tiktok: 'https://www.tiktok.com/',
  openai: 'https://openai.com/',
  anthropic: 'https://www.anthropic.com/',
  cloudflare: 'https://www.cloudflare.com/',
  baidu: 'https://www.baidu.com/',
  bingcn: 'https://cn.bing.com/',
  qq: 'https://www.qq.com/',
  bilibili: 'https://www.bilibili.com/',
  taobao: 'https://www.taobao.com/',
  jd: 'https://www.jd.com/',
});

export async function probeConnectivity(id, fetcher, timeout = 10000) {
  const url = connectivityTargets[id];
  if (!Object.hasOwn(connectivityTargets, id)) throw Error('不支持的测试地址');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = performance.now();
  try {
    const response = await fetcher(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    // An HTTP error is still a response over an established connection. A HEAD
    // probe without browser cookies cannot determine whether a page opens there.
    return { status: response.ok ? 'available' : 'connected', code: response.status, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { status: 'failed', ms: Math.round(performance.now() - started),
      error: controller.signal.aborted ? '连接超时' : /NAME_NOT_RESOLVED|ENOTFOUND/i.test(error.message) ? '域名解析失败'
        : /CERT|SSL/i.test(error.message) ? '证书或 TLS 连接失败' : '连接失败，请检查网络或代理' };
  } finally { clearTimeout(timer); }
}
