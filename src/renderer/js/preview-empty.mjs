const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function previewEmpty() {
  const now = new Date();
  return `<div class="pv-empty"><div class="pv-ghost"><div class="pv-gscreen" aria-label="预览待机锁屏">
    <div class="pv-lock-wallpaper" aria-hidden="true"></div>
    <div class="pv-lock-clock"><svg class="pv-lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="6" y="10" width="12" height="10" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
    <time class="pv-lock-time">${timeFormat.format(now)}</time><span class="pv-lock-date">${dateFormat.format(now)}</span></div>
    <span class="pv-lock-hint">选择文件，开始预览</span><span class="pv-lock-home" aria-hidden="true"></span>
    </div><div class="pv-gneck"></div><div class="pv-gbase"></div></div></div>`;
}

export function initPreviewClock(body) {
  const update = () => {
    const now = new Date(), time = body.querySelector('.pv-lock-time'), date = body.querySelector('.pv-lock-date');
    if (time) { time.textContent = timeFormat.format(now); time.dateTime = now.toISOString(); }
    if (date) date.textContent = dateFormat.format(now);
  };
  new MutationObserver(update).observe(body, { childList: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
  const tick = () => { if (!document.hidden) update(); setTimeout(tick, 60050 - Date.now() % 60000); };
  tick();
}
