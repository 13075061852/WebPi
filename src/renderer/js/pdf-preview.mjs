import { mountPDFTextLayer } from './pdf-text-layer.mjs';

// One continuous reading surface. Render nearby pages on demand rather than
// rasterizing a large document before the first page can be read.
export function mountPDFPreview(canvas, first, loadPage) {
  const queue = new Set();
  const loaded = new Set();
  let busy = false, disposed = false;
  const pages = Array.from({ length: first.pages }, (_, index) => {
    const page = document.createElement('div');
    page.className = 'pdf-page';
    page.dataset.page = index + 1;
    page.setAttribute('aria-label', `PDF 第 ${index + 1} 页`);
    const viewport = first.textLayer?.viewport;
    page.style.aspectRatio = viewport ? `${viewport.width} / ${viewport.height}` : '612 / 792';
    canvas.append(page);
    return page;
  });
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && !loaded.has(entry.target)) queue.add(entry.target);
      else queue.delete(entry.target);
    }
    void drain();
  }, { root: canvas, rootMargin: '700px 0px' });
  const host = canvas.closest('#pvBody');
  const removal = new MutationObserver(() => { if (!canvas.isConnected) dispose(); });
  if (host) removal.observe(host, { childList: true });
  function dispose() { disposed = true; observer.disconnect(); removal.disconnect(); queue.clear(); }
  async function drain() {
    if (busy || disposed) return;
    busy = true;
    try {
      while (queue.size && !disposed && canvas.isConnected) {
        const page = queue.values().next().value;
        queue.delete(page);
        if (loaded.has(page)) continue;
        loaded.add(page);
        page.dataset.loading = 'true';
        try {
          const index = Number(page.dataset.page);
          const response = index === 1 ? { ok: true, data: first } : await loadPage(index);
          if (disposed || !canvas.isConnected) break;
          if (!response?.ok) throw Error(response?.error || '预览失败');
          const { data } = response;
          const viewport = data.textLayer?.viewport;
          if (viewport) page.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
          const image = document.createElement('img');
          image.alt = `PDF 第 ${index} 页`; image.draggable = false; image.src = data.image;
          page.append(image);
          await image.decode();
          if (disposed || !canvas.isConnected) break;
          await mountPDFTextLayer(page, data.textLayer);
          observer.unobserve(page);
        } catch (error) {
          if (!disposed && canvas.isConnected) {
            const note = document.createElement('div'); note.className = 'fv-note';
            note.textContent = `预览失败：${error.message}`; page.replaceChildren(note);
          }
        } finally { delete page.dataset.loading; }
      }
    } finally { busy = false; }
  }
  queue.add(pages[0]);
  void drain();
  pages.forEach(page => observer.observe(page));
  return dispose;
}
