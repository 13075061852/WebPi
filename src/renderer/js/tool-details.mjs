export function setToolDetailsOpen(card, open) {
  card.querySelector('.tool-out').hidden = !open;
  card.querySelector('.tool-line').setAttribute('aria-expanded', String(open));
}

export function wireToolDetails(card, args) {
  const line = card.querySelector('.tool-line');
  const out = card.querySelector('.tool-out');
  const input = card.ownerDocument.createElement('pre');
  input.className = 'tool-input';
  input.textContent = '调用参数\n' + JSON.stringify(args ?? {}, null, 2);
  out.before(input);
  out.textContent = '正在执行，等待工具返回结果…';
  line.setAttribute('role', 'button');
  line.tabIndex = 0;
  line.setAttribute('aria-expanded', 'false');
  const toggle = () => setToolDetailsOpen(card, out.hidden);
  line.addEventListener('click', toggle);
  line.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
  });
}
