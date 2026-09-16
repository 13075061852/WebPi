import { createDeviceMorph } from './device-morph.mjs';

// Animate composed snapshots. The embedded page only receives its final viewport.
export function createLayoutMotion({ setPaused }) {
  const root = document.documentElement;
  const layout = document.querySelector('#layout');
  const host = typeof layout.startViewTransition === 'function' ? layout : root;
  const pending = [];
  const masks = new Set();
  let maskFades = [];
  let running = false;
  const selectors = { sidebar: '#sidebar', center: '#center', chat: '#chat', device: '#pvBody .dev-shell' };
  function measure(morphingDevice = false) {
    return Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      const chrome = morphingDevice && name === 'device';
      const visible = rect?.width > 1 && rect.height > 1 && (chrome || element.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
      if (element) element.style.viewTransitionName = visible && !chrome ? `layout-${name}` : 'none';
      return [name, visible ? rect : null];
    }));
  }
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
      try { await Promise.allSettled(maskFades.map(animation => animation.finished)); }
      finally { document.removeEventListener('visibilitychange', hidden); }
    }
    // A new device choice reverses the reveal and keeps the intermediate page covered.
    if (pending.some(item => item.maskPreview)) return;
    maskFades.forEach(animation => animation.cancel());
    maskFades = [];
    for (const mask of fading) { mask.remove(); masks.delete(mask); }
  }
  async function drain() {
    running = true;
    try {
      await setPaused(true);
      while (pending.length) {
        const changes = pending.splice(0);
        if (masks.size || changes.some(item => item.maskPreview)) coverPreview();
        if (document.hidden || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
          changes.forEach(item => item.change());
          await setPaused(true);
          if (!pending.length) await revealPreview();
          continue;
        }
        root.classList.add('layout-motion');
        root.classList.toggle('layout-motion-global', host === root);
        const origin = host === root ? { x: 0, y: 0 } : host.getBoundingClientRect();
        const before = measure();
        const deviceMorph = host !== root && before.device && masks.size ? createDeviceMorph() : null;
        const motionOptions = { duration: 280, easing: deviceMorph ? 'cubic-bezier(.4,0,.2,1)' : 'cubic-bezier(.22,.68,0,1)', fill: 'both' };
        const restoreViewports = holdViewports();
        root.classList.toggle('layout-device-held', !!before.device && !deviceMorph);
        let after;
        const update = () => {
          changes.forEach(item => item.change());
          after = measure(!!deviceMorph);
          root.classList.toggle('layout-sidebar-enter', !before.sidebar && !!after.sidebar);
          root.classList.toggle('layout-sidebar-leave', !!before.sidebar && !after.sidebar);
        };
        const transition = host === root ? document.startViewTransition(update) : host.startViewTransition({ update });
        const temporary = [];
        const resize = () => { transition.skipTransition(); temporary.forEach(animation => animation.cancel()); deviceMorph?.cancel(); };
        const hidden = () => { if (document.hidden) resize(); };
        if (deviceMorph) window.addEventListener('resize', resize, { once: true });
        document.addEventListener('visibilitychange', hidden);
        try {
          await transition.ready;
          for (const animation of document.getAnimations()) {
            const name = animation.effect?.pseudoElement?.match(/^::view-transition-group\(layout-(\w+)\)$/)?.[1];
            const first = before[name], last = after[name];
            if (!first || !last) continue;
            // Default View Transitions interpolate width/height on the main thread.
            // Constant bounds + transforms let the compositor run the motion.
            const pseudoElement = animation.effect.pseudoElement;
            animation.cancel();
            temporary.push(host.animate([
              { width: `${last.width}px`, height: `${last.height}px`, transform: `translate(${first.x - origin.x}px, ${first.y - origin.y}px) scale(${first.width / last.width}, ${first.height / last.height})` },
              { width: `${last.width}px`, height: `${last.height}px`, transform: `translate(${last.x - origin.x}px, ${last.y - origin.y}px) scale(1, 1)` },
            ], { ...motionOptions, pseudoElement }));
          }
          const motions = [
            ...document.getAnimations().filter(animation => animation.effect?.target === host && animation.effect.pseudoElement),
            ...(deviceMorph?.animate(motionOptions) || []),
          ];
          for (const animation of motions) { animation.pause(); animation.currentTime = 0; }
          // Capture these promises before a resize can cancel native snapshots.
          // Reading .finished after cancellation creates a new, pending promise.
          const motionsFinished = Promise.allSettled(motions.map(animation => animation.finished));
          // Raster the snapshot surfaces before starting their clocks. Otherwise
          // the first texture upload can land in the middle of the slide.
          await new Promise(resolve => {
            let firstFrame, secondFrame;
            const finish = () => { clearTimeout(timeout); cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); resolve(); };
            const timeout = setTimeout(finish, 200);
            firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(finish); });
          });
          if (document.hidden) {
            resize();
            await transition.updateCallbackDone.catch(() => {});
            continue;
          }
          for (const animation of motions) if (animation.playState === 'paused') animation.play();
          if (deviceMorph) {
            await motionsFinished;
            restoreViewports();
            await setPaused(true);
          } else if (before.device && after.device) {
            // Keep the old texture over the live guest until motion has finished.
            // Resizing a busy canvas must not compete with the sliding animation.
            const hold = host.animate({ opacity: [1, 1] }, { duration: 10000, fill: 'both', pseudoElement: '::view-transition-old(layout-device)' });
            temporary.push(hold);
            await motionsFinished;
            restoreViewports();
            await setPaused(true);
            if (!masks.size && !document.hidden) {
              const reveal = host.animate({ opacity: [0, 1] }, { duration: 100, fill: 'forwards', pseudoElement: '::view-transition-new(layout-device)' });
              temporary.push(reveal);
              await reveal.finished.catch(() => {});
            }
            hold.cancel();
          }
          await transition.finished;
        } catch {
          // A window resize or another native transition can skip the animation;
          // the requested state update must still complete exactly once.
          transition.skipTransition();
          await transition.updateCallbackDone.catch(() => {});
        } finally {
          window.removeEventListener('resize', resize);
          document.removeEventListener('visibilitychange', hidden);
          temporary.forEach(animation => animation.cancel());
          restoreViewports();
          deviceMorph?.dispose();
        }
        if (!pending.length && masks.size) {
          // The actual viewport and its first paint must settle before uncovering it.
          await setPaused(true);
          await revealPreview();
        }
      }
    } finally {
      maskFades.forEach(animation => animation.cancel());
      maskFades = [];
      for (const mask of masks) mask.remove();
      masks.clear();
      root.classList.remove('layout-motion', 'layout-motion-global', 'layout-sidebar-enter', 'layout-sidebar-leave', 'layout-device-held');
      for (const selector of Object.values(selectors)) document.querySelector(selector)?.style.removeProperty('view-transition-name');
      running = false;
      void setPaused(false);
    }
  }
  return (change, { maskPreview = false } = {}) => {
    if (maskPreview) {
      maskFades.forEach(animation => animation.cancel());
      maskFades = [];
    }
    pending.push({ change, maskPreview });
    if (!running) void drain();
  };
}
