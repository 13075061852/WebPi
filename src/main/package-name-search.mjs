// Use the same server-rendered search endpoint as pi.dev/packages.
const cache = new Map();
const decode = value => String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (raw, code) => {
  if (code[0] === '#') { const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw; }
  return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[code.toLowerCase()] || raw;
});
const text = html => decode(String(html || '').replace(/<[^>]*>/g, '')).trim();
export function parsePackagePage(html) {
  if (!/class="packages-count"/.test(html)) throw Error('官网目录格式发生变化，请稍后重试');
  const countText = text(html.match(/class="packages-count"[^>]*>([\s\S]*?)<\/span>/)?.[1]);
  // Empty filters use "0 / <catalog size>"; populated pages use
  // "1-50 / <matching total> (of <catalog size>)".
  const count = countText.match(/^(0|\d+\s*-\s*\d+)\s*\/\s*(\d+)(?:\s*\(of\s+\d+\))?$/);
  if (!count) throw Error('官网目录格式发生变化，请稍后重试');
  const total = count[1] === '0' ? 0 : Number(count[2]);
  const objects = [];
  for (const [, attrs, body] of html.matchAll(/<article\b([^>]*data-package-card="true"[^>]*)>([\s\S]*?)<\/article>/g)) {
    const attr = key => decode(attrs.match(new RegExp(key + '="([^"]*)"'))?.[1]);
    const name = attr('data-package-name');
    if (!name) continue;
    const links = [...body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(m => ({ url: decode(m[1]), label: text(m[2]) }));
    const report = links.find(l => l.label === 'report');
    let version = ''; try { version = new URL(report?.url).searchParams.get('package-version') || ''; } catch {}
    const date = Number(attr('data-package-date'));
    objects.push({ package: { name, description: text(body.match(/class="packages-desc"[^>]*>([\s\S]*?)<\/p>/)?.[1]),
      version, date: Number.isFinite(date) && date > 0 ? new Date(date).toISOString() : '',
      publisher: { username: text(body.match(/class="packages-meta"[^>]*>\s*<span>([\s\S]*?)<\/span>/)?.[1]) },
      types: attr('data-package-types').split(/[,\s]+/).filter(Boolean),
      links: { repository: links.find(l => l.label === 'repo')?.url || '', homepage: 'https://pi.dev/packages/' + name } } });
  }
  if (total > 0 && !objects.length) throw Error('官网目录解析失败，请稍后重试');
  return { total, objects };
}
export async function searchPackageNames(category, query, from, size, request = fetch) {
  const type = String(category).split(',')[1] || '';
  const needle = String(query).trim().toLowerCase();
  const pageStart = needle ? 1 : Math.floor(from / 50) + 1;
  const key = JSON.stringify([type, needle, needle ? 0 : from, needle ? 0 : size]);
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.at > 300000) {
    const promise = (async () => {
      const objects = []; let total = 0;
      for (let page = pageStart; ; page++) {
        const url = new URL('https://pi.dev/packages');
        if (needle) url.searchParams.set('name', needle);
        if (type) url.searchParams.set('type', type);
        url.searchParams.set('page', String(page));
        const response = await request(url.href, { signal: AbortSignal.timeout(15000), headers: { Accept: 'text/html' } });
        if (!response.ok) throw Error(response.status === 429 ? '官网请求暂时限流，请稍后重试' : '官网搜索失败 ' + response.status);
        const result = parsePackagePage(await response.text()); total = result.total;
        objects.push(...result.objects);
        if (page * 50 >= total || !result.objects.length || (!needle && objects.length >= from % 50 + size)) break;
        if (page - pageStart >= 199) throw Error('匹配结果过多，请输入更完整的扩展名称');
      }
      const unique = [...new Map(objects.map(o => [o.package.name, o])).values()];
      const matches = needle ? unique.filter(o => o.package.name.toLowerCase().includes(needle)) : unique;
      return { total: needle ? matches.length : total, objects: matches };
    })();
    hit = { at: Date.now(), promise }; cache.set(key, hit);
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    promise.catch(() => { if (cache.get(key) === hit) cache.delete(key); });
  }
  const result = await hit.promise;
  const offset = needle ? from : from % 50;
  return { total: result.total, objects: result.objects.slice(offset, offset + size) };
}
