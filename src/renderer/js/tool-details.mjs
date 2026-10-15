const motions = new WeakMap();

export function setToolDetailsOpen(card, open) {
  const out = card.querySelector('.tool-out');
  const line = card.querySelector('.tool-line');
  const body = card.querySelector('.tool-details');
  const previous = motions.get(card);
  if (line.getAttribute('aria-expanded') === String(open)) return;
  const height = body?.hidden ? 0 : body?.getBoundingClientRect().height || 0;
  const opacity = body?.hidden ? 0 : body ? Number(getComputedStyle(body).opacity) : 1;
  previous?.cancel();
  line.setAttribute('aria-expanded', String(open));
  const settle = () => { out.hidden = !open; if (body) body.hidden = !open; };
  if (!body || !card.isConnected || card.ownerDocument.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    motions.delete(card); settle(); return;
  }
  body.hidden = false;
  out.hidden = false;
  const expandedHeight = body.getBoundingClientRect().height;
  const motion = body.animate([
    { height: `${height}px`, opacity },
    { height: `${open ? expandedHeight : 0}px`, opacity: open ? 1 : 0 },
  ], { duration: 200, easing: 'cubic-bezier(.22,.68,0,1)', fill: 'both' });
  motions.set(card, motion);
  motion.finished.catch(() => {}).finally(() => {
    if (motions.get(card) !== motion) return;
    settle(); motion.cancel(); motions.delete(card);
  });
}

export function wireToolDetails(card, args) {
  const line = card.querySelector('.tool-line');
  const out = card.querySelector('.tool-out');
  const input = card.ownerDocument.createElement('pre');
  input.className = 'tool-input';
  input.textContent = '调用参数\n' + JSON.stringify(args ?? {}, null, 2);
  const body = card.ownerDocument.createElement('div');
  body.className = 'tool-details'; body.hidden = true;
  out.before(body); body.append(input, out);
  out.textContent = '正在执行，等待工具返回结果…';
  line.setAttribute('role', 'button');
  line.tabIndex = 0;
  line.setAttribute('aria-expanded', 'false');
  const toggle = () => setToolDetailsOpen(card, line.getAttribute('aria-expanded') !== 'true');
  line.addEventListener('click', toggle);
  line.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
  });
}
