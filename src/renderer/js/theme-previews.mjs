/** Lazy preview loading with a stable skeleton and decoded-image fade-in. */
export function initThemePreviews(root = document) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      entry.target.loadPreview();
    }
  });
  for (const sample of root.querySelectorAll('.wallpaper-sample')) {
    const source = getComputedStyle(sample).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    if (!source) continue;
    sample.style.backgroundImage = 'none';
    sample.dataset.previewState = 'loading';
    sample.setAttribute('aria-busy', 'true');
    const picture = document.createElement('img');
    picture.alt = '';
    picture.decoding = 'async';
    sample.prepend(picture);
    let running = false;
    sample.loadPreview = async () => {
      if (running) return;
      running = true;
      sample.dataset.previewState = 'loading';
      sample.setAttribute('aria-busy', 'true');
      try {
        // A distinct URL lets an explicit retry bypass a failed browser response.
        picture.src = source + (picture.src ? `?retry=${Date.now()}` : '');
        await picture.decode();
        sample.dataset.previewState = 'ready';
        sample.removeAttribute('title');
      } catch {
        sample.dataset.previewState = 'error';
        sample.title = '图片加载失败，点击重试';
      } finally {
        running = false;
        sample.setAttribute('aria-busy', 'false');
      }
    };
    sample.closest('[data-theme-choice]')?.addEventListener('click', event => {
      if (sample.dataset.previewState !== 'error') return;
      event.stopImmediatePropagation();
      sample.loadPreview();
    }, true);
    observer.observe(sample);
  }
}
