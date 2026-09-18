export function initAppUpdates({api = window.halo, root = document} = {}) {
  const button = root.querySelector('#appUpdateButton');
  let state = {status:'idle'};
  let receivedEvent = false;
  button.setAttribute('aria-live', 'polite');
  const render = next => {
    state = next;
    button.hidden = false;
    button.disabled = ['checking','downloading'].includes(state.status);
    button.dataset.updateStatus = state.status;
    button.classList.toggle('update-attention', !!state.version);
    button.setAttribute('aria-busy', String(button.disabled));
    button.textContent = ({idle:'检查更新',checking:'检查中…',current:'已是最新',development:'检查更新',
      available:'下载更新',downloading:`更新 ${state.percent}%`,ready:'重启更新',error:'重试更新'})[state.status] || '检查更新';
    button.title = state.status === 'downloading' ? `正在下载 v${state.version} · ${state.percent}%`
      : state.status === 'ready' ? `v${state.version} 已下载 · 点击重启安装`
      : state.version ? `发现新版本 v${state.version} · 当前 v${state.currentVersion} · 点击下载，完成后自动重启，请先结束正在执行的任务`
      : state.status === 'development' ? '开发模式，请在安装版检查更新' : `当前版本 ${state.currentVersion || ''} · 检查更新`;
  };
  api.onAppUpdate(next => { receivedEvent = true; render(next); });
  void api.appUpdateState().then(result => {if(result.ok && !receivedEvent) render(result.data);}).catch(() => {});
  button.onclick = () => void (['available','ready'].includes(state.status) ? api.downloadAppUpdate() : api.checkAppUpdate());
}
