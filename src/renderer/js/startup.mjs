/** A compact, accessible view of actual startup work; no simulated percentage. */
export function initStartupProgress({ api = window.halo, root = document, onRetry = () => {} } = {}) {
  const panel = root.getElementById('startupProgress');
  if (!panel || !api?.startupState) return;
  const title = root.getElementById('startupTitle');
  const detail = root.getElementById('startupDetail');
  const elapsed = root.getElementById('startupElapsed');
  const list = root.getElementById('startupSteps');
  const retry = root.getElementById('startupRetry');
  let state, receivedAt = performance.now(), timer;
  function tick() {
    if (!state || state.ready) return;
    const waiting = state.steps.some(step => step.status === 'error') ? 0 : performance.now() - receivedAt;
    elapsed.textContent = `${Math.floor((state.elapsedMs + waiting) / 1000)} 秒`;
  }
  function render(next) {
    if (!next?.steps) return;
    if (Number.isFinite(state?.revision) && next.revision < state.revision) return;
    state = next; receivedAt = performance.now();
    panel.hidden = !!state.ready;
    if (state.ready) { clearInterval(timer); timer = null; return; }
    const failed = state.steps.find(step => step.status === 'error');
    const current = failed || state.steps.find(step => step.status === 'active') || state.steps.find(step => step.status === 'pending');
    panel.dataset.failed = String(!!failed);
    panel.setAttribute('aria-busy', String(!failed));
    title.textContent = failed ? '启动需要处理' : current?.label || '正在完成启动';
    detail.textContent = current?.detail || '正在准备工作空间';
    retry.hidden = !failed || failed.id === 'interface';
    retry.disabled = false;
    list.replaceChildren(...state.steps.map(step => {
      const item = root.createElement('li');
      item.dataset.status = step.status;
      const symbol = step.status === 'complete' ? '✓' : step.status === 'error' ? '!' : '·';
      item.textContent = `${symbol} ${step.label}`;
      return item;
    }));
    tick();
    if (!timer) timer = setInterval(tick, 1000);
  }
  api.onStartupProgress?.(render);
  api.startupState().then(reply => { if (reply?.ok) render(reply.data); }).catch(() => {});
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try {
      const reply = await api.startupRetry();
      if (reply?.ok === false) { detail.textContent = reply.error; retry.disabled = false; }
      else await onRetry();
    } catch (error) { detail.textContent = error?.message || '重试失败'; retry.disabled = false; }
  });
  return { render };
}
