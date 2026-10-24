// Delegate title hints so static and dynamically created controls share one delay.
export function initTooltips(doc = document) {
  const win = doc.defaultView;
  const tip = doc.createElement('div');
  tip.id = 'halo-tooltip';
  tip.className = 'halo-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('popover', 'manual');
  doc.body.append(tip);
  let owner = null, timer = null;
  const titles = new Map();
  const place = () => {
    const anchor = owner.getBoundingClientRect(), box = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(anchor.left + (anchor.width - box.width) / 2, win.innerWidth - box.width - 8))}px`;
    tip.style.top = `${Math.max(8, anchor.bottom + box.height + 8 <= win.innerHeight - 8 ? anchor.bottom + 8 : anchor.top - box.height - 8)}px`;
  };
  const hide = () => {
    win.clearTimeout(timer);
    tip.hidePopover();
    if (owner) {
      const ids = (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tip.id);
      if (ids.length) owner.setAttribute('aria-describedby', ids.join(' '));
      else owner.removeAttribute('aria-describedby');
    }
    owner = null;
    for (const [element, title] of titles) if (!element.hasAttribute('title')) element.setAttribute('title', title);
    titles.clear();
  };
  const show = target => {
    if (!(target instanceof win.Element)) return;
    let next = target;
    while (next && !next.hasAttribute('title') && !titles.has(next)) next = next.parentElement;
    if (next === owner) return;
    hide();
    if (!next?.getAttribute('title')?.trim()) return;
    owner = next;
    // Suppress ancestor native hints too, avoiding a second delayed tooltip.
    for (let element = next; element; element = element.parentElement) {
      if (!element.hasAttribute('title')) continue;
      titles.set(element, element.getAttribute('title'));
      element.removeAttribute('title');
    }
    timer = win.setTimeout(() => {
      if (!owner?.isConnected || !owner.checkVisibility()) { hide(); return; }
      tip.textContent = titles.get(owner);
      const ids = (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      owner.setAttribute('aria-describedby', [...new Set([...ids, tip.id])].join(' '));
      tip.showPopover();
      place();
    }, 150);
  };
  doc.addEventListener('pointerover', event => { if (event.pointerType !== 'touch') show(event.target); });
  doc.addEventListener('pointerout', event => { if (owner && !owner.contains(event.relatedTarget)) hide(); });
  doc.addEventListener('focusin', event => { if (event.target.matches(':focus-visible')) show(event.target); });
  doc.addEventListener('focusout', hide);
  doc.addEventListener('pointerdown', hide, true);
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, true);
  doc.addEventListener('scroll', hide, true);
  win.addEventListener('blur', hide);
  win.addEventListener('resize', hide);
  new win.MutationObserver(records => {
    if (!owner) return;
    if (!owner.isConnected) { hide(); return; }
    if (records.some(record => record.type === 'attributes' && record.attributeName !== 'title' && record.target.contains(owner)) && !owner.checkVisibility()) { hide(); return; }
    for (const record of records) {
      const element = record.target;
      if (record.type !== 'attributes' || !titles.has(element) || !element.hasAttribute('title')) continue;
      const title = element.getAttribute('title');
      titles.set(element, title);
      element.removeAttribute('title');
      if (element === owner) {
        if (!title.trim()) { hide(); return; }
        tip.textContent = title;
        if (tip.matches(':popover-open')) place();
      }
    }
  }).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'hidden', 'class', 'style'] });
}
