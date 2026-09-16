/* Report actual startup work. The main window controls completion after its first paint. */
(() => {
  const status = document.getElementById('status');
  const detail = document.getElementById('startupDetail');
  const elapsed = document.getElementById('elapsed');
  let state, receivedAt = performance.now();
  const render = next => {
    if (!next?.steps) return;
    if (Number.isFinite(state?.revision) && next.revision < state.revision) return;
    state = next; receivedAt = performance.now();
    const current = state.steps.find(step => step.status === 'error') || state.steps.find(step => step.status === 'active');
    status.textContent = current?.label || '正在打开工作空间';
    detail.textContent = current?.detail || '窗口就绪后立即打开';
  };
  window.halo.onStartupProgress(render);
  window.halo.splashDone().then(reply => { if (reply?.ok) render(reply.data); }).catch(() => {});
  setInterval(() => {
    if (state) elapsed.textContent = `${Math.floor((state.elapsedMs + performance.now() - receivedAt) / 1000)} 秒`;
  }, 1000);
})();
