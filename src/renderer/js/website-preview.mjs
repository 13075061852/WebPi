export function websiteURL(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function websiteAddress(value) {
  const text = String(value || '').trim();
  if (!text || /\s/.test(text)) return null;
  if (/^https?:\/\//i.test(text)) return websiteURL(text);
  // Host:port is an address, while explicit non-web schemes remain forbidden.
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(text)) return null;
  const local = /^(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text);
  return websiteURL(`${local ? 'http' : 'https'}://${text}`);
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
  // Let new-window links reach the main-process handler, which denies windows
  // and loads HTTP(S) destinations into this same isolated guest instead.
  body.innerHTML = `<div class="website-browser">
    <form class="website-toolbar">
      <button type="button" data-nav="back" title="返回上一页" aria-label="返回上一页" disabled><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14"/></svg></button>
      <div class="website-address">
        <input aria-label="网站地址" type="text" inputmode="url" spellcheck="false" autocomplete="off" required>
        <button type="submit" title="前往" aria-label="前往"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5 7 7-7 7M5 12h14"/></svg></button>
      </div>
      <span class="website-zoom" role="group" aria-label="网页缩放">
        <button type="button" data-zoom="out" aria-label="缩小网页" title="缩小网页"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>
        <button type="button" data-zoom="reset" aria-label="恢复到 100%" title="恢复到 100%">100%</button>
        <button type="button" data-zoom="in" aria-label="放大网页" title="放大网页"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg></button>
      </span>
      <button type="button" data-nav="external" title="外部打开" aria-label="外部打开"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M21 3 11 13M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg></button>
    </form>
    <webview aria-label="网站预览" partition="persist:website-preview" allowpopups></webview>
  </div>`;
  const guest = body.querySelector('webview'), input = body.querySelector('input');
  if (createDeviceShell) {
    const browser = body.querySelector('.website-browser');
    browser.append(createDeviceShell(guest));
  }
  const back = body.querySelector('[data-nav=back]'), go = body.querySelector('[type=submit]');
  let loadingButton = null, loading = false;
  const setLoading = value => {
    loading = value;
    for (const button of [back, go]) {
      const busy = loading && button === loadingButton;
      button.classList.toggle('is-loading', busy);
      button.setAttribute('aria-busy', String(busy));
      button.disabled = button === back ? !ready || !guest.canGoBack() : loading;
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
  guest.addEventListener('dom-ready', () => { ready = true; applyZoom(); setLoading(loading); });
  input.value = url;
  const sync = () => {
    if (!guest.isConnected) return;
    back.disabled = !ready || !guest.canGoBack();
    input.value = guest.getURL();
    onChange({url:input.value, title:guest.getTitle()});
  };
  guest.addEventListener('did-start-loading', () => { setLoading(true); });
  guest.addEventListener('did-stop-loading', () => { setLoading(false); loadingButton = null; sync(); });
  guest.addEventListener('did-navigate', sync);
  guest.addEventListener('did-navigate-in-page', () => {
    setLoading(guest.isLoading());
    if (!loading) loadingButton = null;
    sync();
  });
  guest.addEventListener('page-title-updated', sync);
  input.addEventListener('input', () => input.setCustomValidity(''));
  body.querySelector('form').onsubmit = event => {
    event.preventDefault(); const next = websiteAddress(input.value);
    if (!next) { input.setCustomValidity('请输入有效的 HTTP 或 HTTPS 网址'); input.reportValidity(); return; }
    input.value = next;
    loadingButton = go; setLoading(true); guest.src = next;
  };
  back.onclick = () => {
    if (!ready || !guest.canGoBack()) return;
    loadingButton = back; setLoading(true); guest.goBack();
  };
  body.querySelector('[data-nav=external]').onclick = () => { const target = websiteURL(input.value); if (target) void window.halo.openExternal(target); };
  guest.src = url;
  return guest;
}
