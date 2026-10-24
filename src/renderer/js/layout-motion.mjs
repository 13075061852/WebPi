import { createDeviceMorph } from './device-morph.mjs';

function within(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview layout motion timed out')), ms);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// Animate the workspace while holding embedded pages at their settled viewport.
export function createLayoutMotion({ setPaused }) {
  const root = document.documentElement;
  const layout = document.querySelector('#layout');
  const pending = [];
  const masks = new Set();
  let maskFades = [];
  let running = false;
  const selectors = { sidebar: '#sidebar', center: '#center', chat: '#chat', device: '#pvBody .dev-shell' };
  function holdViewports() {
    const held = [...document.querySelectorAll('#pvBody iframe, #pvBody webview')].map(element => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return () => {};
      const properties = { width: `${width}px`, height: `${height}px`, flex: 'none' };
      const previous = Object.keys(properties).map(key => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]);
      for (const [key, value] of Object.entries(properties)) element.style.setProperty(key, value, 'important');
      return () => { for (const [key, value, priority] of previous) { if (value) element.style.setProperty(key, value, priority); else element.style.removeProperty(key); } };
    });
    return () => held.forEach(restore => restore());
  }
  function coverPreview() {
    const screens = [...document.querySelectorAll('#pvBody .dev-screen')];
    if (!screens.length) screens.push(document.querySelector('#pvBody'));
    for (const screen of screens) {
      // Documents render in the live layout; covering them would introduce an
      // unnecessary blank screen on every device change.
      if (screen?.closest('.dev-document-shell')) continue;
      if (!screen || [...masks].some(mask => mask.parentElement === screen)) continue;
      const mask = document.createElement('div');
      mask.className = 'device-switch-mask';
      mask.setAttribute('aria-hidden', 'true');
      screen.appendChild(mask);
      masks.add(mask);
    }
  }
  async function revealPreview() {
    const fading = [...masks];
    if (!fading.length) return;
    if (!document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      maskFades = fading.map(mask => mask.animate({ opacity: [1, 0] }, { duration: 120, easing: 'ease-out', fill: 'both' }));
      const hidden = () => { if (document.hidden) maskFades.forEach(animation => animation.cancel()); };
      document.addEventListener('visibilitychange', hidden);
      try { await within(Promise.allSettled(maskFades.map(animation => animation.finished)), 700).catch(() => {}); }
      finally { document.removeEventListener('visibilitychange', hidden); }
    }
    // A new device choice reverses the reveal and keeps the intermediate page covered.
    if (pending.some(item => item.maskPreview)) return;
    maskFades.forEach(animation => animation.cancel());
    maskFades = [];
    for (const mask of fading) { mask.remove(); masks.delete(mask); }
  }
  async function slideLivePanes(changes) {
    // Panes must stay live in every theme: scaling captured textures can stretch
    // the entire text layer during Chromium's snapshot capture/handoff.
    const panes = [...layout.children].filter(element => element.matches('#sidebar, #center, #chat'));
    const visible = panes.filter(element => element.getBoundingClientRect().width > 1 && element.checkVisibility({ visibilityProperty: true }));
    const before = getComputedStyle(layout).gridTemplateColumns;
    const restoreViewports = holdViewports();
    let restoreOpenedViewports = () => {};
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let animation;
    const cancel = () => animation?.cancel();
    const hidden = () => { if (document.hidden) cancel(); };
    const reduce = () => { if (reduced.matches) cancel(); };
    root.classList.add('layout-motion', 'layout-motion-live');
    root.classList.remove('layout-motion-global', 'layout-sidebar-enter', 'layout-sidebar-leave', 'layout-device-held', 'layout-preview-fold');
    for (const selector of Object.values(selectors)) document.querySelector(selector)?.style.removeProperty('view-transition-name');
    try {
      // Read, commit and animate in one task so the final layout never flashes
      // before the animation's first frame. State/ARIA are committed just once.
      changes.forEach(item => item.change());
      const after = getComputedStyle(layout).gridTemplateColumns;
      // A folded guest starts at zero width. Hold its final dimensions now,
      // before interpolation, while already-held guests keep their old size.
      restoreOpenedViewports = holdViewports();
      for (const element of visible) element.classList.add('layout-live-visible');
      animation = layout.animate({ gridTemplateColumns: [before, after] }, {
        duration: 280, easing: 'cubic-bezier(.22,.68,0,1)', fill: 'both',
      });
      window.addEventListener('resize', cancel);
      document.addEventListener('visibilitychange', hidden);
      reduced.addEventListener('change', reduce);
      await within(animation.finished, 1500).catch(() => {});
    } finally {
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', hidden);
      reduced.removeEventListener('change', reduce);
      animation?.cancel();
      panes.forEach(element => element.classList.remove('layout-live-visible'));
      restoreOpenedViewports();
      restoreViewports();
      root.classList.remove('layout-motion-live');
    }
    await within(setPaused(true), 350).catch(() => {});
  }
  async function morphLiveDevice(changes) {
    const panes = [...layout.children].filter(element => element.matches('#sidebar, #center, #chat'));
    const before = new Map(panes.map(element => [element, element.getBoundingClientRect()]));
    const restoreViewports = holdViewports();
    const morph = createDeviceMorph();
    const animations = [];
    const restores = [];
    let interrupted = false;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const cancel = () => animations.forEach(animation => animation.cancel());
    const interrupt = () => { interrupted = true; cancel(); };
    const hidden = () => { if (document.hidden) interrupt(); };
    const reduce = () => { if (reduced.matches) interrupt(); };
    root.classList.add('layout-motion', 'layout-motion-live');
    panes.filter(element => element.checkVisibility({ visibilityProperty: true })).forEach(element => element.classList.add('layout-live-visible'));
    try {
      // Commit the final grid once. Interpolating grid tracks reflows a long
      // transcript on every frame; translate and clip fixed-size live panes.
      changes.forEach(item => item.change());
      const after = new Map(panes.map(element => [element, element.getBoundingClientRect()]));
      const options = { duration: 280, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' };
      if (morph) animations.push(...morph.animate(options));
      for (const element of panes) {
        const first = before.get(element), last = after.get(element);
        if (!first.width || !last.width || (first.x === last.x && first.width === last.width)) continue;
        const width = Math.max(first.width, last.width);
        const properties = ['width', 'will-change', 'overflow'];
        const saved = properties.map(key => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]);
        restores.push(() => saved.forEach(([key, value, priority]) => value ? element.style.setProperty(key, value, priority) : element.style.removeProperty(key)));
        element.style.width = `${width}px`;
        const clips = element.id !== 'chat';
        element.style.willChange = clips ? 'transform, clip-path' : 'transform';
        element.style.overflow = 'hidden';
        // The window already clips the chat's right edge. An additional moving
        // clip on the transcript needlessly rasterizes newly exposed text tiles.
        const animation = element.animate([
          { transform: `translateX(${first.x - last.x}px)`, ...(clips ? { clipPath: `inset(0 ${width - first.width}px 0 0)` } : {}) },
          { transform: 'translateX(0px)', ...(clips ? { clipPath: `inset(0 ${width - last.width}px 0 0)` } : {}) },
        ], options);
        animation.id = 'device-pane-motion';
        animations.push(animation);
      }
      // Raster the fixed-size panes and new chrome before advancing the clocks.
      // Otherwise uploading the first text texture consumes the first slide frames.
      // Raster a subpixel intermediate shape too, so new clip surfaces are
      // uploaded while stationary rather than during the first moving frames.
      for (const animation of animations) { animation.pause(); animation.currentTime = 1; }
      // Capture before an interrupt can replace a cancelled .finished promise.
      const finished = Promise.allSettled(animations.map(animation => animation.finished));
      window.addEventListener('resize', interrupt);
      document.addEventListener('visibilitychange', hidden);
      reduced.addEventListener('change', reduce);
      await new Promise(resolve => {
        let frame, paints = 0;
        const finish = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve(); };
        const timer = setTimeout(finish, 120);
        const raster = () => { if (++paints === 4) finish(); else frame = requestAnimationFrame(raster); };
        frame = requestAnimationFrame(raster);
      });
      for (const animation of animations) if (animation.playState === 'paused') { animation.currentTime = 0; animation.play(); }
      await within(finished, 1500).catch(() => {});
    } finally {
      window.removeEventListener('resize', interrupt);
      document.removeEventListener('visibilitychange', hidden);
      reduced.removeEventListener('change', reduce);
      if (interrupted) morph?.dispose();
      else morph?.finish();
      cancel();
      restores.forEach(restore => restore());
      restoreViewports();
      // Paint the guest at its final viewport before removing the chrome cover.
      await within(setPaused(true), 350).catch(() => {});
      morph?.dispose();
      panes.forEach(element => element.classList.remove('layout-live-visible'));
      root.classList.remove('layout-motion-live');
    }
  }
  async function drain() {
    running = true;
    try {
      // Drain the guest's already-scheduled native frame before starting the
      // slide; otherwise a busy canvas uploads its last frame mid-animation.
      await within(setPaused(true), 350).catch(() => {});
      while (pending.length) {
        const changes = pending.splice(0);
        if (masks.size || changes.some(item => item.maskPreview)) coverPreview();
        if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
          changes.forEach(item => item.change());
          await within(setPaused(true), 350).catch(() => {});
          if (!pending.length) await revealPreview();
          continue;
        }
        const embeddedPage = document.querySelector('#pvBody .dev-shell:not(.dev-document-shell) :is(iframe, webview)');
        if (changes.every(item => item.device) && embeddedPage) await morphLiveDevice(changes);
        else await slideLivePanes(changes);
        if (!pending.length && masks.size) {
          // Both motion paths already fence the final guest paint. Do not wait
          // for a second identical IPC/paint round before revealing it.
          await revealPreview();
        }
      }
    } finally {
      maskFades.forEach(animation => animation.cancel());
      maskFades = [];
      for (const mask of masks) mask.remove();
      masks.clear();
      root.classList.remove('layout-motion', 'layout-motion-live', 'layout-motion-global', 'layout-sidebar-enter', 'layout-sidebar-leave', 'layout-device-held', 'layout-preview-fold');
      for (const selector of Object.values(selectors)) document.querySelector(selector)?.style.removeProperty('view-transition-name');
      running = false;
      void setPaused(false);
    }
  }
  return (change, { maskPreview = false, previewFold = false, device = false } = {}) => {
    if (maskPreview) {
      // Cover before asynchronous pause/paint work, including sidebar and pane toggles.
      coverPreview();
      maskFades.forEach(animation => animation.cancel());
      maskFades = [];
    }
    if (device) {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].device) pending.splice(i, 1);
    }
    pending.push({ change, maskPreview, previewFold, device });
    if (!running) void drain();
  };
}
