const endpoint = 'https://api.github.com/repos/13075061852/WebPi/releases';

export function createReleaseHistory({ fetchImpl = globalThis.fetch, offline = false } = {}) {
  let cached, pending, checked = 0;
  return async function load() {
    if (offline) throw Error('当前处于离线模式');
    if (cached && Date.now() - checked < 300000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const releases = [];
      // Fetch all public pages under one bounded timeout. Never include draft releases.
      const signal = AbortSignal.timeout(12000);
      for (let page = 1; ; page++) {
        const response = await fetchImpl(`${endpoint}?per_page=100&page=${page}`, {
          headers: { Accept: 'application/vnd.github+json' }, signal,
        });
        if (!response.ok) throw Error(`GitHub 请求失败（${response.status}）`);
        const data = await response.json();
        if (!Array.isArray(data)) throw Error('版本记录格式异常');
        for (const item of data) {
          if (item.draft || item.prerelease || !/^v?\d+\.\d+\.\d+$/.test(item.tag_name) || !item.published_at) continue;
          releases.push({ version: item.tag_name.replace(/^v/, ''), date: item.published_at,
            body: typeof item.body === 'string' ? item.body : '',
            url: `https://github.com/13075061852/WebPi/releases/tag/${encodeURIComponent(item.tag_name)}` });
        }
        if (data.length < 100) break;
      }
      cached = releases; checked = Date.now(); return releases;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
