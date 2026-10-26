// Preserve the current visual frame when an opening/closing dialog reverses.
export function createModalMotion({ syncPreview }) {
  const states = new WeakMap();
  const focus = new WeakMap(), stack = [];
  const targets = element => [...element.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
    .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[hidden], [inert]'));
  const firstFocus = element => (targets(element)[0] || element).focus({ preventScroll: true });
  document.addEventListener('keydown', event => {
    const top = stack.at(-1);
    if (!top || event.key !== 'Tab') return;
    const nodes = targets(top), index = nodes.indexOf(document.activeElement);
    if (!nodes.length || (event.shiftKey ? index <= 0 : index === nodes.length - 1 || index < 0)) {
      event.preventDefault(); (event.shiftKey ? nodes.at(-1) || top : nodes[0] || top).focus({ preventScroll: true });
    }
  });
  document.addEventListener('focusin', event => {
    const top = stack.at(-1);
    if (top && !top.contains(event.target)) firstFocus(top);
  });
  async function change(element, opening) {
    if (!element) return;
    const nativeDialog = element.tagName === 'DIALOG';
    const closed = nativeDialog ? !element.open : element.hidden;
    if (!opening && closed) return;
    const previous = states.get(element);
    if (previous?.opening === opening) return;
    const returnFocus = focus.get(element) || document.activeElement;
    const panel = element.querySelector('.modal-panel') || element;
    const from = closed ? '0' : getComputedStyle(element).opacity;
    const transform = closed ? 'translateY(10px) scale(.985)' : getComputedStyle(panel).transform;
    previous?.animations.forEach(animation => animation.cancel());
    const state = { opening, animations: [] };
    states.set(element, state);
    element.hidden = false;
    element.style.opacity = from;
    panel.style.transform = transform;
    element.classList.toggle('show', opening);
    if (nativeDialog && opening && !element.open) element.showModal();
    if (opening && !focus.has(element)) {
      focus.set(element, returnFocus);
      stack.push(element);
      element.setAttribute('role', 'dialog'); element.setAttribute('aria-modal', 'true');
      if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) {
        const heading = element.querySelector('h3');
        if (heading) { heading.id ||= `${element.id}-heading`; element.setAttribute('aria-labelledby', heading.id); }
      }
      element.tabIndex = -1;
      firstFocus(element);
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (opening && !reduced) await syncPreview(true);
    else void syncPreview();
    if (states.get(element) !== state) return;
    if (!reduced) {
      const options = { duration: opening ? 200 : 160, easing: opening ? 'cubic-bezier(.2,.7,.2,1)' : 'ease-in', fill: 'both' };
      state.animations = [
        element.animate({ opacity: [from, opening ? '1' : '0'] }, options),
        panel.animate({ transform: [transform, opening ? 'none' : 'translateY(8px) scale(.985)'] }, options),
      ];
      await Promise.allSettled(state.animations.map(animation => animation.finished));
    }
    if (states.get(element) !== state) return;
    element.hidden = !opening;
    state.animations.forEach(animation => animation.cancel());
    element.style.removeProperty('opacity');
    panel.style.removeProperty('transform');
    states.delete(element);
    if (nativeDialog && !opening) element.close();
    if (!opening) {
      const previousFocus = focus.get(element);
      focus.delete(element);
      const index = stack.indexOf(element); if (index >= 0) stack.splice(index, 1);
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
      else if (stack.length) firstFocus(stack.at(-1));
    }
    void syncPreview();
  }
  return { open: element => { void change(element, true); }, close: element => { void change(element, false); } };
}
