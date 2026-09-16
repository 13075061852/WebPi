export function initAppUpdates({api = window.halo, root = document} = {}) {
  const button = root.querySelector('#appUpdateButton');
  const check = root.querySelector('#checkAppUpdate');
  let state = {status:'idle'};
  const render = next => {
    state = next;
    button.hidden = ['idle','current','development','checking'].includes(state.status);
    button.disabled = state.status === 'downloading';
    button.textContent = state.status === 'downloading' ? `更新 ${state.percent}%` : state.status === 'ready' ? '重启更新' : state.status === 'error' ? '重试更新' : '有更新';
    button.title = state.version ? `v${state.version} · 点击下载，完成后自动重启，请先结束正在执行的任务` : '检查更新';
    check.disabled = ['checking','downloading'].includes(state.status);
    check.textContent = ({checking:'正在检查…',downloading:`下载中 ${state.percent}%`,current:'已是最新版本',development:'开发模式，安装版可更新',error:'检查失败，点击重试'})[state.status] || '检查软件更新';
  };
  api.onAppUpdate(render);
  void api.appUpdateState().then(result => {if(result.ok) render(result.data);});
  check.onclick = () => void api.checkAppUpdate();
  button.onclick = () => void (['available','ready'].includes(state.status) ? api.downloadAppUpdate() : api.checkAppUpdate());
}
