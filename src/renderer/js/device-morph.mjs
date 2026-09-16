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
  const first = capture(), old = layer();
  Object.assign(old.container.style, first.body);
  Object.assign(old.chrome.style, first.shell);
  document.body.appendChild(overlay);
  body.classList.add('device-morph-hidden');
  shell.style.viewTransitionName = 'none';
  return {
    animate(options) {
      const last = capture(), next = layer();
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
    cancel() { animations.forEach(animation => animation.cancel()); },
    dispose() {
      animations.forEach(animation => animation.cancel());
      overlay.remove();
      body.classList.remove('device-morph-hidden');
    },
  };
}
