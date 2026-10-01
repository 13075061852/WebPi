import { XMLParser } from 'fast-xml-parser';
import { bundledReleases } from '../renderer/js/release-history-data.mjs';

const repository = 'https://github.com/13075061852/WebPi';
const endpoint = 'https://api.github.com/repos/13075061852/WebPi/releases';
const stableTag = /^v?(\d+\.\d+\.\d+)$/;
const feedLink = /^https:\/\/github\.com\/13075061852\/WebPi\/releases\/tag\/(v?\d+\.\d+\.\d+)$/;
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Pi-Halo' };
const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });

function requestError(error) {
  if (/GitHub|版本记录|发布记录/.test(error?.message || '')) return error;
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return Error('GitHub 请求超时，请检查网络或代理');
  return Error('无法连接 GitHub，请检查网络或系统代理');
}

function responseError(response) {
  const limited = response.status === 429 || (response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0');
  return Error(limited ? `GitHub 请求已限流（${response.status}），请稍后重试` : `GitHub 请求失败（${response.status}）`);
}

function textNotes(content) {
  // Atom notes contain escaped HTML; convert formatting to text. The renderer
  // continues to use textContent, including any subsequently decoded markup.
  const text = typeof content === 'string' ? content : content?.['#text'] || '';
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:br\b[^>]*|\/(?:p|div|h[1-6]|ul|ol))>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] || whole;
      const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : whole;
    }).replace(/\n{3,}/g, '\n\n').trim();
}

export function createReleaseHistory({ fetchImpl = globalThis.fetch, offline = false, now = Date.now } = {}) {
  let cached, pending, checked = 0, apiRetryAt = 0;
  async function readApi() {
    const releases = [], signal = AbortSignal.timeout(12000);
    for (let page = 1; ; page++) {
      const response = await fetchImpl(`${endpoint}?per_page=100&page=${page}`, { headers, signal });
      if (!response.ok) {
        if (response.status === 429 || (response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0')) {
          const retry = Number(response.headers?.get('retry-after'));
          const reset = Number(response.headers?.get('x-ratelimit-reset')) * 1000;
          apiRetryAt = Math.max(now() + (retry > 0 ? retry * 1000 : 60000), reset || 0);
        }
        throw responseError(response);
      }
      const data = await response.json();
      if (!Array.isArray(data)) throw Error('版本记录格式异常');
      for (const item of data) {
        const match = stableTag.exec(item.tag_name);
        if (item.draft || item.prerelease || !match || !Number.isFinite(Date.parse(item.published_at))) continue;
        releases.push({ version: match[1], date: item.published_at,
          body: typeof item.body === 'string' ? item.body : '', url: `${repository}/releases/tag/${encodeURIComponent(item.tag_name)}` });
      }
      if (data.length < 100) break;
    }
    return releases;
  }

  async function readPublicFeed() {
    const signal = AbortSignal.timeout(12000);
    // This website endpoint, also used by electron-updater, identifies the
    // latest stable release without consuming the anonymous REST API quota.
    const latestResponse = await fetchImpl(`${repository}/releases/latest`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Pi-Halo' }, signal,
    });
    if (!latestResponse.ok) throw responseError(latestResponse);
    const latest = await latestResponse.json();
    const latestMatch = stableTag.exec(latest.tag_name);
    if (!latestMatch || latest.draft || latest.prerelease) throw Error('GitHub 正式发布记录格式异常');
    const response = await fetchImpl(`${repository}/releases.atom`, {
      headers: { Accept: 'application/atom+xml', 'User-Agent': 'Pi-Halo' }, signal,
    });
    if (!response.ok) throw responseError(response);
    const source = await response.text();
    if (source.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw Error('GitHub 发布记录格式异常');
    let feed;
    try { feed = xml.parse(source).feed; } catch { throw Error('GitHub 发布记录格式异常'); }
    if (!feed) throw Error('GitHub 发布记录格式异常');
    const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
    // Atom omits the prerelease flag. Admit only the website-confirmed latest
    // stable release and older releases confirmed in our shipped notes.
    const published = new Set([...bundledReleases.map(item => item.version), latestMatch[1]]);
    const releases = new Map();
    for (const entry of entries) {
      const links = Array.isArray(entry.link) ? entry.link : [entry.link];
      const href = links.find(link => link?.['@_rel'] === 'alternate' || !link?.['@_rel'])?.['@_href'];
      const match = typeof href === 'string' && feedLink.exec(href);
      const version = match && stableTag.exec(match[1])?.[1];
      const date = entry.published || entry.updated;
      if (!version || !published.has(version) || !Number.isFinite(Date.parse(date))) continue;
      releases.set(version, { version, date, body: textNotes(entry.content), url: href });
    }
    if (!releases.has(latestMatch[1])) throw Error('GitHub 最新发布记录缺失');
    return [...releases.values()];
  }

  return async function load(force = false) {
    if (offline) throw Error('当前处于离线模式');
    if (cached && force !== true && now() - checked < 300000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        if (now() < apiRetryAt) throw Error('GitHub 请求已限流，请稍后重试');
        cached = await readApi();
      } catch (error) {
        const apiError = requestError(error);
        try { cached = await readPublicFeed(); }
        catch (fallbackError) { throw Error(`${apiError.message}；备用入口：${requestError(fallbackError).message}`); }
      }
      checked = now(); return cached;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
