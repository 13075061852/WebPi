// Bound both socket and response-body waits. A failed registry check must leave
// installed package metadata available, including when the user is offline.
export async function checkPackageUpdates(packages, { request = fetch, concurrency = 4, timeoutMs = 6000, inferTypes = () => [] } = {}) {
  let next = 0;
  async function worker() {
    while (next < packages.length) {
      const pkg = packages[next++];
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(Error('Registry request timed out')); }, timeoutMs);
      });
      try {
        const data = await Promise.race([(async () => {
          const name = pkg.source.slice(4).replace(/@[^/]*$/, (suffix, offset) => offset ? '' : suffix);
          const response = await request('https://registry.npmjs.org/' + name.split('/').map(encodeURIComponent).join('/') + '/latest', { signal: controller.signal });
          if (!response.ok) { await response.body?.cancel(); return null; }
          return response.json();
        })(), timeout]);
        if (data && typeof data.version === 'string') {
          pkg.latest = data.version;
          pkg.update = !!pkg.version && pkg.version !== pkg.latest;
          pkg.author ||= data._npmUser?.name || (typeof data.author === 'string' ? data.author : data.author?.name) || '';
          pkg.desc ||= data.description || '';
          pkg.homepage ||= data.homepage || '';
          pkg.repo ||= typeof data.repository === 'string' ? data.repository : data.repository?.url || '';
          pkg.types ||= inferTypes(data);
        }
      } catch { /* Keep the locally installed package visible on lookup failure. */ }
      finally { clearTimeout(timer); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), packages.length) }, worker));
}
