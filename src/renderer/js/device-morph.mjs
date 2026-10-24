// Only clone the inexpensive device chrome. Never clone an iframe or webview:
// the original page stays mounted, paused and covered until its final paint.
export function createDeviceMorph() {
  const body = document.querySelector('#pvBody');
  const shell = body?.querySelector('.dev-shell');
  if (!shell?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return null;
  const animations = [];
  const overlay = document.createElement('div');
  overlay.className = 'device-morph-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = true;
  function capture() {
    const bounds = body.getBoundingClientRect(), frame = shell.getBoundingClientRect();
    const style = getComputedStyle(shell), glass = getComputedStyle(shell, '::before');
    return {
      body: { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` },
      shell: { left: `${frame.x - bounds.x}px`, top: `${frame.y - bounds.y}px`, width: `${frame.width}px`, height: `${frame.height}px`,
        borderRadius: style.borderRadius, paddingTop: style.paddingTop, paddingRight: style.paddingRight, paddingBottom: style.paddingBottom, paddingLeft: style.paddingLeft },
      glass: { borderRadius: glass.borderRadius },
      screen: { borderRadius: getComputedStyle(shell.querySelector('.dev-screen')).borderRadius },
    };
  }
  function layer() {
    const container = body.cloneNode(false);
    container.removeAttribute('id'); container.removeAttribute('style');
    container.classList.remove('device-morph-hidden');
    container.classList.add('device-morph-layer');
    const chrome = shell.cloneNode(false);
    chrome.removeAttribute('id'); chrome.removeAttribute('style');
    chrome.classList.add('device-morph-shell');
    const status = shell.querySelector('.dev-statusbar');
    if (status) chrome.appendChild(status.cloneNode(true));
    const screen = document.createElement('div');
    screen.className = 'dev-screen';
    chrome.appendChild(screen);
    container.appendChild(chrome);
    overlay.appendChild(container);
    return { container, chrome, screen };
  }
  function place(skin, frame) {
    // Set the underlying geometry as well as the animation's first keyframe.
    // A newly attached WAAPI effect may not be sampled until the next frame.
    Object.assign(skin.container.style, frame.body);
    Object.assign(skin.chrome.style, frame.shell);
  }
  function clip(frame) {
    const rect = frame.body;
    return `inset(${rect.top} ${innerWidth - parseFloat(rect.left) - parseFloat(rect.width)}px ${innerHeight - parseFloat(rect.top) - parseFloat(rect.height)}px ${rect.left})`;
  }
  const first = capture(), old = layer();
  place(old, first);
  overlay.style.clipPath = clip(first);
  document.body.appendChild(overlay);
  body.classList.add('device-morph-hidden');
  shell.style.viewTransitionName = 'none';
  let finalFrame = first;
  return {
    animate(options) {
      const last = capture(), next = layer();
      finalFrame = last;
      place(next, first);
      animations.push(overlay.animate({ clipPath: [clip(first), clip(last)] }, options));
      for (const skin of [old, next]) {
        animations.push(
          skin.container.animate([first.body, last.body], options),
          skin.chrome.animate([first.shell, last.shell], options),
          skin.chrome.animate([first.glass, last.glass], { ...options, pseudoElement: '::before' }),
          skin.screen.animate([first.screen, last.screen], options),
          skin.container.animate({ opacity: skin === old ? [1, 0] : [0, 1] }, options),
        );
      }
      return animations;
    },
    finish() {
      // Keep the final chrome in place while the guest paints its resized
      // viewport. Cancelling filled effects alone exposes the old geometry.
      overlay.style.clipPath = clip(finalFrame);
      for (const container of overlay.children) {
        Object.assign(container.style, finalFrame.body);
        Object.assign(container.querySelector('.device-morph-shell').style, finalFrame.shell);
      }
      overlay.firstElementChild.style.opacity = '0';
      overlay.lastElementChild.style.opacity = '1';
      // The opaque overlay still covers the guest. Make its real surface visible
      // before the paint fence: hidden frames cannot deliver the requested paint.
      body.classList.remove('device-morph-hidden');
    },
    cancel() { animations.forEach(animation => animation.cancel()); },
    dispose() {
      animations.forEach(animation => animation.cancel());
      overlay.remove();
      body.classList.remove('device-morph-hidden');
    },
  };
}
