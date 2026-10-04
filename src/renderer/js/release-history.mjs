import { bundledReleases } from './release-history-data.mjs';

export function initReleaseHistory({ root = document, api = window.halo } = {}) {
  const get = id => root.querySelector(`#${id}`);
  const list = get('releaseHistoryList'), refresh = get('releaseHistoryRefresh');
  const nav = get('releaseHistoryNav');
  const loading = get('releaseHistoryLoading');
  const repo = 'https://github.com/13075061852/WebPi';
  let releases = bundledReleases, current = '', pending = null, ready = false, rendered = '';
  let scrollFrame = null;
  const reducedMotion = () => list.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function stopScroll() {
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  }
  function scrollToEntry(entry) {
    stopScroll();
    const start = list.scrollTop;
    const target = Math.max(0, Math.min(list.scrollHeight - list.clientHeight,
      entry === list.firstElementChild ? 0 : start + entry.getBoundingClientRect().top - list.getBoundingClientRect().top));
    highlight(entry.dataset.version);
    if (reducedMotion() || Math.abs(target - start) < 1) { list.scrollTop = target; return; }
    const started = performance.now();
    const step = now => {
      const progress = Math.min(1, (now - started) / 360);
      list.scrollTop = start + (target - start) * (1 - Math.pow(1 - progress, 3));
      scrollFrame = progress < 1 ? requestAnimationFrame(step) : null;
    };
    scrollFrame = requestAnimationFrame(step);
  }
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    list.addEventListener(event, () => { stopScroll(); syncPosition(); }, { passive: true });
  }
  const node = (tag, text, className) => {
    const element = list.ownerDocument.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  async function open(url) {
    try {
      const result = await api.openExternal(url);
      if (!result?.ok) throw Error('无法打开链接');
    } catch { get('releaseHistoryStatus').textContent = '无法打开链接，请稍后重试'; }
  }
  function highlight(version) {
    for (const button of nav.children) {
      const active = button.dataset.version === version;
      button.classList.toggle('active', active);
      if (active) {
        button.setAttribute('aria-current', 'location');
        nav.style.setProperty('--release-selection-y', `${button.offsetTop}px`);
        nav.style.setProperty('--release-selection-height', `${button.offsetHeight}px`);
      }
      else button.removeAttribute('aria-current');
    }
  }
  function syncPosition() {
    if (!list.clientHeight || scrollFrame !== null) return;
    const top = list.getBoundingClientRect().top;
    let active = list.firstElementChild;
    for (const entry of list.children) {
      if (entry.getBoundingClientRect().top <= top + 28) active = entry;
      else break;
    }
    if (list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 2) active = list.lastElementChild;
    highlight(active?.dataset.version);
  }
  list.addEventListener('scroll', syncPosition, { passive: true });
  new ResizeObserver(() => {
    const active = nav.querySelector('[aria-current]');
    if (active) highlight(active.dataset.version);
  }).observe(nav);
  function render() {
    const signature = JSON.stringify([current, releases]);
    if (signature === rendered) return;
    stopScroll();
    const previousTop = list.scrollTop;
    const previousNavTop = nav.scrollTop;
    // Keep the same paragraph in view when a new release is inserted above it.
    const listTop = list.getBoundingClientRect().top;
    const anchor = previousTop > 0 ? [...list.children].find(entry => entry.getBoundingClientRect().bottom > listTop) : undefined;
    const anchorVersion = anchor?.dataset.version;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - listTop : 0;
    list.replaceChildren(...releases.map(release => {
      const article = node('article', undefined, 'release-entry');
      article.dataset.version = release.version;
      article.id = `release-version-${release.version}`;
      const heading = node('div', undefined, 'release-entry-heading');
      const title = node('h4', `v${release.version}`);
      heading.appendChild(title);
      if (release.version === current) heading.appendChild(node('span', '当前版本', 'release-current-badge'));
      const date = node('time', release.date.slice(0, 10)); date.dateTime = release.date;
      heading.appendChild(date);
      article.appendChild(heading);
      // Remote release notes are untrusted text, never injected as HTML.
      const notes = node('div', undefined, 'release-notes');
      for (const block of (release.body || '此版本暂未提供更新说明。').trim().split(/\n\s*\n/)) {
        const lines = block.split('\n');
        if (lines.every(line => /^[-*] /.test(line))) {
          const ul = node('ul');
          for (const line of lines) ul.appendChild(node('li', line.slice(2)));
          notes.appendChild(ul);
        } else notes.appendChild(node('p', block));
      }
      article.appendChild(notes);
      const link = node('button', '查看 GitHub 发布页', 'release-page-link');
      link.type = 'button';
      // Construct from a validated version, not an arbitrary remote URL.
      link.onclick = () => void open(`${repo}/releases/tag/v${release.version}`);
      article.appendChild(link);
      return article;
    }));
    nav.replaceChildren(...releases.map(release => {
      const button = node('button', undefined, 'release-nav-item');
      button.type = 'button'; button.dataset.version = release.version;
      button.setAttribute('aria-controls', `release-version-${release.version}`);
      button.appendChild(node('b', `v${release.version}`));
      button.appendChild(node('small', release.version === current ? '当前版本' : release.date.slice(0, 10)));
      button.onclick = () => {
        const entry = [...list.children].find(item => item.dataset.version === release.version);
        if (!entry) return;
        scrollToEntry(entry);
      };
      return button;
    }));
    list.scrollTop = previousTop;
    if (anchorVersion) {
      const replacement = [...list.children].find(entry => entry.dataset.version === anchorVersion);
      if (replacement) list.scrollTop += replacement.getBoundingClientRect().top - list.getBoundingClientRect().top - anchorOffset;
    }
    nav.scrollTop = previousNavTop;
    highlight(releases[0]?.version);
    syncPosition();
    rendered = signature;
  }
  function load(force = false) {
    if (pending) return pending;
    refresh.disabled = true;
    get('releaseHistoryStatus').textContent = '正在同步版本记录…';
    pending = (async () => {
      try {
        const result = await api.releaseHistory(force === true);
        if (!result?.ok) throw Error(result?.error || '同步失败');
        if (!Array.isArray(result.data)) throw Error('版本记录格式异常');
        const merged = new Map(bundledReleases.map(item => [item.version, item]));
        for (const item of result.data) {
          if (item && /^\d+\.\d+\.\d+$/.test(item.version) && typeof item.date === 'string' && typeof item.body === 'string') merged.set(item.version, item);
        }
        releases = [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
        get('releaseHistoryStatus').textContent = '已同步 GitHub 正式版本';
      } catch (error) {
        const reason = String(error?.message || '同步失败').replace(/\s+/g, ' ').slice(0, 80);
        get('releaseHistoryStatus').textContent = `${reason}，显示本地记录`;
      } finally {
        // Commit the first list once, with its current-version badge already ready.
        await currentReady;
        loading.hidden = true; nav.hidden = false; list.hidden = false;
        ready = true;
        render();
        pending = null; refresh.disabled = false;
      }
    })();
    return pending;
  }
  get('releaseRepository').onclick = () => void open(repo);
  refresh.onclick = () => void load(true);
  root.querySelector('[data-pane="history"]').addEventListener('click', () => void load());
  loading.hidden = false; nav.hidden = true; list.hidden = true;
  const currentReady = Promise.resolve().then(() => api.appUpdateState()).then(result => {
    current = result?.data?.currentVersion || '';
    get('releaseCurrentVersion').textContent = current ? `当前安装 v${current}` : '正式发布记录';
    if (ready) render();
  }).catch(() => { get('releaseCurrentVersion').textContent = '正式发布记录'; });
  // Preload while the app starts instead of waiting for the pane's first click.
  void load();
  return { refresh: load };
}
