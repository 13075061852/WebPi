// Preserve the current visual frame when an opening/closing dialog reverses.
export function createModalMotion({ syncPreview }) {
  const states = new WeakMap();
  async function change(element, opening) {
    if (!element) return;
    const nativeDialog = element.tagName === 'DIALOG';
    const closed = nativeDialog ? !element.open : element.hidden;
    if (!opening && closed) return;
    const previous = states.get(element);
    if (previous?.opening === opening) return;
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
    void syncPreview();
  }
  return { open: element => { void change(element, true); }, close: element => { void change(element, false); } };
}
