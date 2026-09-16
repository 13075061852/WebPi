export function initAppUpdates({api = window.halo, root = document} = {}) {
  const button = root.querySelector('#appUpdateButton');
  let state = {status:'idle'};
  const render = next => {
    state = next;
    button.hidden = false;
    button.disabled = ['checking','downloading'].includes(state.status);
    button.textContent = ({idle:'检查更新',checking:'检查中…',current:'已是最新',development:'检查更新',
      available:'有更新',downloading:`更新 ${state.percent}%`,ready:'重启更新',error:'重试更新'})[state.status] || '检查更新';
    button.title = state.version ? `v${state.version} · 点击下载，完成后自动重启，请先结束正在执行的任务`
      : state.status === 'development' ? '开发模式，请在安装版检查更新' : `当前版本 ${state.currentVersion || ''} · 检查更新`;
  };
  api.onAppUpdate(render);
  void api.appUpdateState().then(result => {if(result.ok) render(result.data);});
  button.onclick = () => void (['available','ready'].includes(state.status) ? api.downloadAppUpdate() : api.checkAppUpdate());
}
