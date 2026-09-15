export function websiteURL(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function renderWebsiteCards(turn, open) {
  const urls = [...(turn.__websiteURLs || [])].filter(websiteURL);
  if (!urls.length) return;
  // The deployment card owns the URL; also deduplicate restored older replies.
  const delivered = new Set(urls.map(websiteURL));
  for (const link of turn.querySelectorAll('.md a[href]')) {
    if (!delivered.has(websiteURL(link.getAttribute('href')))) continue;
    const block = link.closest('p, li');
    if (block && block.textContent.trim() === link.textContent.trim() && block.querySelectorAll('a').length === 1) {
      block.remove();
    } else {
      link.replaceWith(delivered.has(websiteURL(link.textContent.trim())) ? '' : link.textContent);
    }
  }
  let box = turn.querySelector(':scope > .website-deliveries');
  if (!box) { box = document.createElement('div'); box.className = 'website-deliveries'; turn.append(box); }
  box.replaceChildren();
  for (const url of urls) {
    const card = document.createElement('div'); card.className = 'website-card';
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'website-open';
    const title = document.createElement('strong'); title.textContent = '网站已部署 · 点击预览';
    const address = document.createElement('span'); address.textContent = url;
    preview.append(title, address); preview.onclick = () => open(url);
    const actions = document.createElement('div'); actions.className = 'website-actions';
    for (const [label, action] of [['复制网址', async () => {
      await navigator.clipboard.writeText(url);
    }], ['外部打开 ↗', () => window.halo.openExternal(url)]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = async () => { try { await action(); if (label === '复制网址') button.textContent = '已复制'; } catch { button.textContent = '请重试'; } };
      actions.append(button);
    }
    card.append(preview, actions); box.append(card);
  }
}

export function mountWebsiteBrowser(body, url, onChange, createDeviceShell) {
  body.innerHTML = '<div class="website-browser"><form class="website-toolbar"><button type="button" data-nav="reload" title="刷新" aria-label="刷新">↻</button><input aria-label="网站地址" type="url" required><button type="submit">前往</button><span class="website-zoom"><button type="button" data-zoom="out" aria-label="缩小网页" title="缩小网页">−</button><button type="button" data-zoom="reset" aria-label="恢复到 100%" title="恢复到 100%">100%</button><button type="button" data-zoom="in" aria-label="放大网页" title="放大网页">+</button></span><button type="button" data-nav="external" title="外部打开" aria-label="外部打开">↗</button></form><div class="website-load" role="status" hidden></div><webview title="网站预览" partition="website-preview"></webview></div>';
  const guest = body.querySelector('webview'), input = body.querySelector('input'), status = body.querySelector('.website-load');
  if (createDeviceShell) {
    const browser = body.querySelector('.website-browser');
    browser.append(createDeviceShell(guest));
  }
  const reload = body.querySelector('[data-nav=reload]'), go = body.querySelector('[type=submit]');
  let loadingButton = reload;
  const setLoading = loading => {
    for (const button of [reload, go]) {
      const busy = loading && button === loadingButton;
      button.classList.toggle('is-loading', busy);
      button.setAttribute('aria-busy', String(busy));
      button.disabled = loading;
    }
  };
  const levels = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
  let zoom = 100, ready = false;
  const zoomOut = body.querySelector('[data-zoom=out]'), zoomIn = body.querySelector('[data-zoom=in]');
  const zoomReset = body.querySelector('[data-zoom=reset]');
  const applyZoom = () => {
    if (ready) guest.setZoomFactor(zoom / 100);
    zoomReset.textContent = `${zoom}%`;
    zoomOut.disabled = zoom === levels[0]; zoomIn.disabled = zoom === levels.at(-1);
  };
  zoomOut.onclick = () => { zoom = levels[Math.max(0, levels.indexOf(zoom) - 1)]; applyZoom(); };
  zoomIn.onclick = () => { zoom = levels[Math.min(levels.length - 1, levels.indexOf(zoom) + 1)]; applyZoom(); };
  zoomReset.onclick = () => { zoom = 100; applyZoom(); };
  guest.addEventListener('ipc-message', event => {
    if (event.channel !== 'website-zoom' || !ready) return;
    if (event.args[0] === 'in') zoomIn.onclick();
    else if (event.args[0] === 'out') zoomOut.onclick();
  });
  const stopZoom = window.halo.onWebsiteZoom?.(({guestId, direction}) => {
    if (!ready || !guest.isConnected || guest.getWebContentsId() !== guestId) return;
    if (direction === 'in') zoomIn.onclick();
    else if (direction === 'out') zoomOut.onclick();
  });
  const cleanup = new MutationObserver(() => {
    if (!guest.isConnected) { stopZoom?.(); cleanup.disconnect(); }
  });
  cleanup.observe(body, {childList:true, subtree:true});
  guest.addEventListener('dom-ready', () => { ready = true; applyZoom(); });
  input.value = url;
  const sync = () => {
    if (!guest.isConnected) return;
    input.value = guest.getURL();
    onChange({url:input.value, title:guest.getTitle()});
  };
  guest.addEventListener('did-start-loading', () => { status.hidden = true; setLoading(true); });
  guest.addEventListener('did-stop-loading', () => { setLoading(false); loadingButton = reload; sync(); });
  guest.addEventListener('did-navigate', sync);
  guest.addEventListener('did-navigate-in-page', sync);
  guest.addEventListener('page-title-updated', sync);
  guest.addEventListener('did-fail-load', event => {
    if (event.isMainFrame && event.errorCode !== -3) { status.hidden = false; status.textContent = '网页暂时无法加载，请刷新重试或外部打开'; }
  });
  body.querySelector('form').onsubmit = event => {
    event.preventDefault(); const next = websiteURL(input.value);
    if (next) { loadingButton = go; status.hidden = true; setLoading(true); guest.src = next; }
  };
  reload.onclick = () => { loadingButton = reload; status.hidden = true; setLoading(true); guest.reload(); };
  body.querySelector('[data-nav=external]').onclick = () => { const target = websiteURL(input.value); if (target) void window.halo.openExternal(target); };
  guest.src = url;
  return guest;
}
