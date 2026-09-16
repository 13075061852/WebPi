export function createAppUpdates({updater, app, emit = () => {}, getWindow}) {
  let busy = false, state = {status:'idle', currentVersion:app.getVersion(), version:null, percent:0};
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  const update = patch => { state = {...state,...patch}; emit(state); };
  const progress = value => { const win = getWindow(); if (win && !win.isDestroyed()) win.setProgressBar(value); };
  updater.on('error', () => { if(state.status === 'ready') { progress(-1); update({status:'error'}); } });
  updater.on('download-progress', info => {
    const percent = Math.max(0, Math.min(100, Math.round(info.percent)));
    update({status:'downloading',percent}); progress(percent / 100);
  });
  async function check(manual = false) {
    if (busy) return state;
    if (!app.isPackaged) { if(manual) update({status:'development'}); return state; }
    if (state.status === 'ready') return state;
    busy = true;
    const previous = state;
    update({status:'checking'});
    let available = null;
    const found = info => { available = info; };
    updater.once('update-available', found);
    try {
      await updater.checkForUpdates();
      update(available ? {status:'available',version:available.version} : {status:'current',version:null});
    } catch { update(manual ? {status:'error'} : previous); }
    finally { updater.removeListener('update-available', found); busy = false; }
    return state;
  }
  async function download() {
    if (busy) return state;
    if (state.status === 'ready') { updater.quitAndInstall(true,true); return state; }
    if (state.status !== 'available') throw Error('请先检查是否有新版本');
    busy = true; update({status:'downloading',percent:0}); progress(0);
    try {
      await updater.downloadUpdate();
      update({status:'ready',percent:100}); progress(-1);
      updater.quitAndInstall(true,true);
    } catch { progress(-1); update({status:'error'}); }
    finally { busy = false; }
    return state;
  }
  return {check, download, getState:() => state};
}
