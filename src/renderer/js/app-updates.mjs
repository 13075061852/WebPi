export function initAppUpdates({api = window.halo, root = document, notify = () => {}} = {}) {
  const button = root.querySelector('#appUpdateButton');
  let state = {status:'idle'};
  let receivedEvent = false;
  let notifiedVersion;
  button.setAttribute('aria-live', 'polite');
  const render = next => {
    state = next;
    if (state.status === 'ready' && state.version !== notifiedVersion) {
      notifiedVersion = state.version;
      notify(`新版本 v${state.version} 已下载，点击“重启更新”安装`, 'ok');
    }
    button.hidden = false;
    button.disabled = ['checking','downloading','preparing','installing'].includes(state.status);
    button.dataset.updateStatus = state.status;
    button.classList.toggle('update-attention', !!state.version);
    button.setAttribute('aria-busy', String(button.disabled));
    button.textContent = ({idle:'检查更新',checking:'检查中…',current:'已是最新',development:'检查更新',
      available:'后台下载',downloading:`下载 ${state.percent}%`,ready:'重启更新',preparing:'检查任务…',waiting:'取消等待',installing:'正在更新…',error:'重试更新'})[state.status] || '检查更新';
    button.title = state.error ? `更新失败：${state.error}`
      : state.status === 'downloading' ? `正在下载 v${state.version} · ${state.percent}% · 不会自动安装`
      : state.status === 'ready' ? `v${state.version} 已下载 · 点击重启安装`
      : state.status === 'waiting' ? `v${state.version} 已下载，等待 ${state.tasks?.length || 0} 个任务结束后更新 · 点击取消等待`
      : state.status === 'error' ? `更新失败：${state.error || '请检查网络后重试'}`
      : state.version ? `发现新版本 v${state.version} · 正在后台下载，完成后由你确认安装`
      : state.status === 'development' ? '开发模式，请在安装版检查更新' : `当前版本 ${state.currentVersion || ''} · 检查更新`;
  };
  api.onAppUpdate(next => { receivedEvent = true; render(next); });
  void api.appUpdateState().then(result => {if(result.ok && !receivedEvent) render(result.data);}).catch(() => {});
  button.onclick = async () => {
    if (button.disabled) return;
    const action = state.status === 'ready' ? api.installAppUpdate
      : state.status === 'waiting' ? api.cancelAppUpdateInstall
      : state.status === 'available' ? api.downloadAppUpdate : api.checkAppUpdate;
    button.disabled = true;
    try {
      const result = await action.call(api);
      if (result?.ok === false) { state = {...state,error:result.error}; notify(result.error,'err'); }
      else if (result?.data) state = result.data;
    } catch (error) { state = {...state,error:error.message}; notify(error.message,'err'); }
    finally { render(state); }
  };
}
