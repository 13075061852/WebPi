import { bundledReleases } from './release-history-data.mjs';

export function initReleaseHistory({ root = document, api = window.halo } = {}) {
  const get = id => root.querySelector(`#${id}`);
  const list = get('releaseHistoryList'), refresh = get('releaseHistoryRefresh');
  const nav = get('releaseHistoryNav');
  const repo = 'https://github.com/13075061852/WebPi';
  let releases = bundledReleases, current = '', busy = false;
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
    stopScroll();
    const previousTop = list.scrollTop;
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
    highlight(releases[0]?.version);
    syncPosition();
  }
  async function load() {
    if (busy) return;
    busy = true; refresh.disabled = true;
    get('releaseHistoryStatus').textContent = '正在同步版本记录…';
    try {
      const result = await api.releaseHistory();
      if (!result?.ok || !Array.isArray(result.data)) throw Error('无法同步');
      const merged = new Map(bundledReleases.map(item => [item.version, item]));
      for (const item of result.data) {
        if (/^\d+\.\d+\.\d+$/.test(item.version) && typeof item.date === 'string' && typeof item.body === 'string') merged.set(item.version, item);
      }
      releases = [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
      render(); get('releaseHistoryStatus').textContent = '已同步 GitHub 正式版本';
    } catch { get('releaseHistoryStatus').textContent = '同步暂不可用，显示已保存记录'; }
    finally { busy = false; refresh.disabled = false; }
  }
  get('releaseRepository').onclick = () => void open(repo);
  refresh.onclick = () => void load();
  root.querySelector('[data-pane="history"]').addEventListener('click', () => void load());
  render();
  void api.appUpdateState().then(result => {
    current = result?.data?.currentVersion || '';
    get('releaseCurrentVersion').textContent = current ? `当前安装 v${current}` : '正式发布记录';
    render();
  }).catch(() => { get('releaseCurrentVersion').textContent = '正式发布记录'; });
  return { refresh: load };
}
