/** Startup progress is driven by completed work, never an animation timer. */
export function createStartupLifecycle({ now = () => Math.round(process.uptime() * 1000), onChange = () => {}, onInterfaceReady = () => {}, reveal = () => {} } = {}) {
  const steps = [
    { id: 'interface', label: '加载主界面', status: 'active', detail: '正在准备窗口和交互控件' },
    { id: 'core', label: '初始化智能体与会话', status: 'pending', detail: '加载本地模型配置、扩展和上次会话' },
    { id: 'workspace', label: '恢复工作空间', status: 'pending', detail: '恢复聊天记录、项目和文件列表' },
  ];
  const timings = { mainEntry: now() };
  let painted = false, wired = false, interfaceReady = false, shown = false, disposed = false, revision = 0;
  const snapshot = () => ({
    steps: steps.map(step => ({ ...step })), timings: { ...timings }, elapsedMs: now(),
    ready: steps.every(step => step.status === 'complete'), revision,
  });
  const publish = () => { if (!disposed) { revision++; onChange(snapshot()); } };
  const maybeReveal = () => {
    if (disposed || shown || !painted || !wired || steps[0].status === 'error') return;
    if (!interfaceReady) {
      interfaceReady = true;
      onInterfaceReady();
    }
    // Keep the small launch window until the workspace is usable. On failure,
    // reveal the main window so its error details and retry controls are available.
    if (disposed || shown || !steps.every(step => step.status === 'complete') && !steps.some(step => step.status === 'error')) return;
    shown = true;
    timings.windowShown = now();
    reveal();
    publish();
  };
  const setStep = (id, status, detail) => {
    if (disposed) return;
    const step = steps.find(item => item.id === id);
    if (!step) return;
    step.status = status;
    if (detail !== undefined) step.detail = String(detail);
    if (status === 'complete') timings[`${id}Ready`] = now();
    publish();
    maybeReveal();
  };
  return {
    snapshot,
    begin: (id, detail) => setStep(id, 'active', detail),
    complete: id => setStep(id, 'complete'),
    fail: (id, error) => setStep(id, 'error', error?.message || error || '启动失败'),
    painted() { if (disposed || painted) return; painted = true; timings.firstPaint = now(); maybeReveal(); },
    wired() { if (disposed || wired || steps[0].status === 'error') return; wired = true; setStep('interface', 'complete'); maybeReveal(); },
    dispose() { disposed = true; },
  };
}
