const STORAGE_KEY = 'halo-sidebar-height-ratio';

export function initSidebarHeight(root = document) {
  const sidebar = root.querySelector('#sidebar'), handle = root.querySelector('#sideHeightHandle');
  if (!sidebar || !handle) return;
  const nav = root.querySelector('#sideNav'), footer = root.querySelector('#modelCard');
  let ratio = .5, drag = null, frame = 0;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const value = saved === null ? NaN : Number(saved);
    if (Number.isFinite(value) && value >= 0 && value <= 1) ratio = value;
  } catch { /* A blocked storage area must not disable resizing. */ }
  sidebar.classList.add('height-adjustable');
  function bounds() {
    const top = nav.getBoundingClientRect().bottom;
    const space = Math.max(0, footer.getBoundingClientRect().top - top - handle.offsetHeight);
    const min = Math.min(96, space / 2);
    return { top, space, min };
  }
  function apply() {
    frame = 0;
    const { space, min } = bounds();
    const height = Math.max(min, Math.min(space - min, space * ratio));
    sidebar.style.setProperty('--side-top-height', `${height}px`);
    handle.setAttribute('aria-valuenow', String(space ? Math.round(height / space * 100) : 50));
    handle.setAttribute('aria-valuemin', String(space ? Math.ceil(min / space * 100) : 50));
    handle.setAttribute('aria-valuemax', String(space ? Math.floor((space - min) / space * 100) : 50));
  }
  function save() { try { localStorage.setItem(STORAGE_KEY, String(ratio)); } catch {} }
  function move(y) {
    const { top, space, min } = bounds();
    if (!space) return;
    ratio = Math.max(min, Math.min(space - min, y - top - drag.offset)) / space;
    if (!frame) frame = requestAnimationFrame(apply);
  }
  function finish(cancel = false) {
    if (!drag) return;
    const { id, original } = drag;
    drag = null;
    if (cancel) ratio = original;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    root.body.classList.remove('sidebar-height-dragging');
    if (frame) cancelAnimationFrame(frame);
    apply(); save();
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { id: event.pointerId, original: ratio, offset: event.clientY - handle.getBoundingClientRect().top };
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    root.body.classList.add('sidebar-height-dragging');
  });
  handle.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) move(event.clientY); });
  handle.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) { move(event.clientY); finish(); } });
  handle.addEventListener('pointercancel', () => finish(true));
  handle.addEventListener('lostpointercapture', () => finish());
  handle.addEventListener('dblclick', () => { ratio = .5; apply(); save(); });
  handle.addEventListener('keydown', event => {
    const { space, min } = bounds();
    if (!space || !['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const current = Number.parseFloat(sidebar.style.getPropertyValue('--side-top-height'));
    const next = event.key === 'Home' ? min : event.key === 'End' ? space - min
      : current + (event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 40 : 12);
    ratio = Math.max(min, Math.min(space - min, next)) / space;
    apply(); save();
  });
  window.addEventListener('blur', () => finish());
  const observer = new ResizeObserver(apply);
  for (const element of [sidebar, nav, footer]) observer.observe(element);
  apply();
  window.addEventListener('beforeunload', () => { finish(); observer.disconnect(); if (frame) cancelAnimationFrame(frame); }, { once: true });
}
