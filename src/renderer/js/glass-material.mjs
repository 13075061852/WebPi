// Shared by real pages, dialogs and controls. Media and document content keep their own rendering.
const surfaceSelector = [
  // Full-titlebar lens overlays inherit the native drag region and cover window buttons.
  // Compact titlebar controls share its CSS glass; separate lenses look raised and crowded.
  '#sidebar', '#chat', '.pv-head', '.pv-devices',
  '.modal-panel', 'dialog.image-viewer', '#mentionMenu', '.server-group-menu > div', '.toast',
  '.input-shell', '.welcome-prompts button', '.artifact-card',
  '.set-nav.active', '.theme-base-modes [aria-pressed="true"]', '#sideNav .nav-item.active', '.pvdev.active',
  '.proxy-card', '.environment-tool', '.github-settings', '.pkg-card', '.pkg-row', '.set-pager',
  '.digital-human-profile-fields > section', '.usage-overview', '.usage-card', '.release-repository',
  '#videoBalance', '.video-estimate', '.video-confirmation', '.wallpaper-transparency',
  '.auth-progress', '.model-item.current', '.notice',
  '.set-search input', '#modelSearch', '#authSearch', '.server-form input', '.server-form select',
  '.video-fields input', '.video-fields select', '.digital-human-form textarea', '.digital-human-form select',
  '.modal input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])',
  '.modal textarea', '.modal select',
  '.modal .mini-btn:not(.accent):not(.danger)', '.modal .env-btn:not(.accent):not(.danger)',
].join(', ');

// A smooth, shape-aware lens at the perimeter; the middle and foreground stay still.
export function initGlassMaterial() {
  const root = document.documentElement;
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('glass-filter-defs');
  const defs = document.createElementNS(namespace, 'defs');
  svg.append(defs);
  document.body.append(svg);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const lenses = new Map();
  let enabled = false, discover = false, lensFrame = 0, serial = 0;
  function removeFilter(element, lens) {
    lens.filter?.remove();
    lens.filter = null;
    lens.signature = '';
    element.classList.remove('glass-lens');
    element.style.removeProperty('--glass-refraction');
  }
  function queueLenses() {
    if (enabled && !lensFrame) lensFrame = requestAnimationFrame(renderLenses);
  }
  const resize = new ResizeObserver(queueLenses);
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const lens = lenses.get(entry.target);
      if (lens) lens.visible = entry.isIntersecting;
    }
    queueLenses();
  });
  const cleanClasses = value => (value || '').split(/\s+/).filter(name => !['glass-surface', 'glass-static', 'glass-lens'].includes(name)).join(' ');
  const cleanStyle = value => (value || '').split(';').map(part => part.trim()).filter(part => part && !part.startsWith('--glass-')).join(';');
  const changes = new MutationObserver(records => {
    const meaningful = records.some(record => {
      if (svg.contains(record.target)) return false;
      if (record.attributeName === 'class') return cleanClasses(record.oldValue) !== cleanClasses(record.target.getAttribute('class'));
      if (record.attributeName === 'style') return cleanStyle(record.oldValue) !== cleanStyle(record.target.getAttribute('style'));
      return true;
    });
    if (meaningful) { discover = true; queueLenses(); }
  });

  function radiiFor(element, width, height) {
    const style = getComputedStyle(element);
    return ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map(name => {
      const values = style[name].split(' ');
      const pixels = (value, extent) => parseFloat(value) * (value.endsWith('%') ? extent / 100 : 1);
      return Math.min(width / 2, height / 2, pixels(values[0], width), pixels(values[1] || values[0], height)) || 0;
    });
  }
  function buildFilter(element, lens, width, height, radii) {
    // Limit both resolution and simultaneous filters, including very large artifact cards.
    const ratio = Math.min(1, 768 / width, 768 / height, Math.sqrt(196608 / (width * height)));
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const pixels = context.createImageData(canvas.width, canvas.height);
    const band = Math.max(5, Math.min(12, Math.min(width, height) * .18));
    for (let y = 0; y < canvas.height; y++) {
      const py = (y + .5) * height / canvas.height - height / 2;
      for (let x = 0; x < canvas.width; x++) {
        const px = (x + .5) * width / canvas.width - width / 2;
        const radius = radii[py < 0 ? (px < 0 ? 0 : 1) : (px < 0 ? 3 : 2)];
        const qx = Math.abs(px) - width / 2 + radius;
        const qy = Math.abs(py) - height / 2 + radius;
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
        const length = Math.hypot(ox, oy);
        const depth = -(length + Math.min(Math.max(qx, qy), 0) - radius);
        let dx = 0, dy = 0;
        if (depth > 0 && depth < band) {
          // Zero displacement at both ends of the band avoids seams and a rippled center.
          const bend = Math.sin(Math.PI * depth / band) ** 2;
          const nx = length ? ox / length : (qx > qy ? 1 : 0);
          const ny = length ? oy / length : (qx > qy ? 0 : 1);
          dx = -Math.sign(px) * nx * bend;
          dy = -Math.sign(py) * ny * bend;
        }
        const index = (y * canvas.width + x) * 4;
        pixels.data[index] = Math.round(127.5 + dx * 127.5);
        pixels.data[index + 1] = Math.round(127.5 + dy * 127.5);
        pixels.data[index + 2] = 128;
        pixels.data[index + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    const filter = lens.filter || document.createElementNS(namespace, 'filter');
    if (!lens.filter) filter.id = `halo-glass-lens-${++serial}`;
    for (const [name, value] of Object.entries({ x: 0, y: 0, width, height, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) filter.setAttribute(name, value);
    const map = document.createElementNS(namespace, 'feImage');
    for (const [name, value] of Object.entries({ x: 0, y: 0, width, height, preserveAspectRatio: 'none', result: 'lens-map', href: canvas.toDataURL('image/png') })) map.setAttribute(name, value);
    const displacement = document.createElementNS(namespace, 'feDisplacementMap');
    for (const [name, value] of Object.entries({ in: 'SourceGraphic', in2: 'lens-map', scale: band * 1.2, xChannelSelector: 'R', yChannelSelector: 'G' })) displacement.setAttribute(name, value);
    filter.replaceChildren(map, displacement);
    if (!lens.filter) defs.append(filter);
    lens.filter = filter;
    element.style.setProperty('--glass-refraction', `url("#${filter.id}") blur(.65px)`);
    element.classList.add('glass-lens');
  }
  function renderLenses() {
    lensFrame = 0;
    if (!enabled || !context) return;
    if (discover) {
      discover = false;
      const candidates = new Set(document.querySelectorAll(surfaceSelector));
      for (const [element, lens] of lenses) {
        if (candidates.has(element)) continue;
        removeFilter(element, lens);
        element.classList.remove('glass-surface', 'glass-static');
        resize.unobserve(element);
        intersection.unobserve(element);
        lenses.delete(element);
      }
      for (const element of candidates) {
        if (lenses.has(element)) continue;
        lenses.set(element, { visible: true, filter: null, signature: '' });
        element.classList.add('glass-surface');
        if (getComputedStyle(element).position === 'static') element.classList.add('glass-static');
        resize.observe(element);
        intersection.observe(element);
      }
    }
    // Foreground sheets always get the optics budget, regardless of conversation length.
    const dialogs = [...document.querySelectorAll('.modal:not([hidden]), dialog[open]')].filter(dialog => dialog.getClientRects().length);
    const foreground = dialogs.at(-1);
    const priority = element => element.matches('.modal-panel, dialog.image-viewer') ? 0
      : element === document.activeElement ? 1
      : element.matches('#mentionMenu, .server-group-menu > div, .toast') ? 2
      : element.matches('input, select, textarea, button') ? 4 : 3;
    const ordered = [...lenses].sort((a, b) => priority(a[0]) - priority(b[0]));
    let visibleCount = 0, generated = 0, pending = false;
    for (const [element, lens] of ordered) {
      if (root.classList.contains('layout-motion-live') && element.closest('#layout')) {
        // Grid widths change every frame. Discard stale maps now, then rebuild
        // once at the final size; the CSS frost is stable in the meantime.
        if (lens.filter) removeFilter(element, lens);
        continue;
      }
      const rect = element.getBoundingClientRect();
      const visible = (!foreground || foreground === element || foreground.contains(element)) && lens.visible && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      if (!visible || ++visibleCount > 24) { if (lens.filter) removeFilter(element, lens); continue; }
      // Layout dimensions ignore the modal's opening transform and control press animation.
      const width = element.offsetWidth, height = element.offsetHeight;
      const radii = radiiFor(element, width, height);
      const signature = [width, height, ...radii].join(':');
      if (signature === lens.signature) continue;
      if (generated >= 3) { pending = true; continue; }
      buildFilter(element, lens, width, height, radii);
      lens.signature = signature;
      generated++;
    }
    if (pending) queueLenses();
  }
  function syncTheme() {
    enabled = root.dataset.surface === 'glass';
    if (enabled) {
      changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-pressed', 'aria-selected'] });
      discover = true;
      queueLenses();
    } else {
      changes.disconnect();
      resize.disconnect();
      intersection.disconnect();
      if (lensFrame) cancelAnimationFrame(lensFrame);
      lensFrame = 0;
      for (const [element, lens] of lenses) {
        removeFilter(element, lens);
        element.classList.remove('glass-surface', 'glass-static');
      }
      lenses.clear();
      canvas.width = canvas.height = 1;
    }
  }
  window.addEventListener('resize', queueLenses, { passive: true });
  document.addEventListener('focusin', queueLenses);
  document.addEventListener('themechange', syncTheme);
  new MutationObserver(records => {
    if (records.some(record => record.attributeName === 'data-surface')) syncTheme();
    if (records.some(record => record.attributeName === 'class')) queueLenses();
  }).observe(root, { attributes: true, attributeFilter: ['data-surface', 'class'] });
  syncTheme();
}
