const stages = { preparing: '正在准备', submitting: '正在提交', generating: '正在生成', saving: '正在保存' };

// The service provides no measured percentage. Keep the indicator indeterminate.
export function mountImageProgress(parent, { startedAt = Date.now(), stage = 'preparing' } = {}) {
  const card = document.createElement('div');
  card.className = 'image-generation-progress';
  card.setAttribute('aria-busy', 'true');
  card.innerHTML = `<div class="image-generation-dots" aria-hidden="true"></div>
    <svg class="image-generation-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="5" y="7" width="22" height="19" rx="4"/><circle cx="12" cy="13" r="2"/><path d="m6 23 6-6 4 4 4-5 6 7"/></svg>
    <div class="image-generation-meta"><span class="image-generation-stage" role="status"></span><span class="image-generation-elapsed"></span></div>
    <div class="image-generation-track" role="progressbar" aria-label="图片生成进度"><span></span></div>`;
  parent.append(card);
  const label = card.querySelector('.image-generation-stage');
  const elapsed = card.querySelector('.image-generation-elapsed');
  let active = true;
  const tick = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    elapsed.textContent = seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  };
  const update = (progress = {}) => {
    if (!active) return;
    if (Number.isFinite(progress.startedAt) && progress.startedAt > 0) startedAt = progress.startedAt;
    if (stages[progress.stage]) stage = progress.stage;
    label.textContent = stages[stage] || stages.generating;
    tick();
  };
  update();
  return { card, tick, update, get statusText() { return label.textContent; }, remove: () => card.remove(), finish: state => {
    if (!active) return;
    active = false;
    tick();
    card.setAttribute('aria-busy', 'false');
    card.classList.add('is-settled');
    card.classList.toggle('is-error', state === 'failed');
    card.querySelector('.image-generation-track').remove();
    label.textContent = { succeeded: '生成完成', failed: '生成失败', cancelled: '已取消' }[state] || '已结束';
  } };
}
