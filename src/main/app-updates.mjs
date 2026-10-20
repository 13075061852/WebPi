export function createAppUpdates({updater, app, emit = () => {}, getWindow,
  getTasks = async () => [], confirmInstall = async () => 'cancel', beforeInstall = async () => {}, onInstallError = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer)}) {
  let checking, downloading, installing = false, deciding = false, waitTimer, waiting = false, disposed = false;
  let state = {status:'idle', currentVersion:app.getVersion(), version:null, percent:0};
  // This controller starts the download exactly once after each successful check.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  const update = patch => { state = {...state,...patch}; emit(state); };
  const progress = value => { const win = getWindow(); if (win && !win.isDestroyed()) win.setProgressBar(value); };
  const stopWaiting = () => { waiting = false; if (waitTimer) cancel(waitTimer); waitTimer = undefined; };
  const failed = error => {
    progress(-1); stopWaiting();
    update({status:'error',error:String(error?.message || error)});
    if (installing) { installing = false; onInstallError(error); }
  };
  updater.on('error', error => { if (installing) failed(error); });
  updater.on('download-progress', info => {
    if (!downloading || disposed) return;
    const percent = Math.max(0, Math.min(100, Math.round(info.percent || 0)));
    update({status:'downloading',percent}); progress(percent / 100);
  });
  async function check(manual = false) {
    if (checking) return checking;
    if (downloading || installing || deciding || ['ready','waiting'].includes(state.status)) return state;
    if (!app.isPackaged) { if(manual) update({status:'development'}); return state; }
    checking = (async () => {
      const previous = state;
      update({status:'checking',error:null});
      let available;
      const found = info => { available = info; };
      updater.once('update-available', found);
      try {
        await updater.checkForUpdates();
        if (disposed) return;
        update(available ? {status:'available',version:available.version} : {status:'current',version:null});
        if (available) await download();
      } catch (error) { if (!disposed) update(manual ? {status:'error',error:error.message} : previous); }
      finally { updater.removeListener('update-available', found); }
    })();
    try { await checking; } finally { checking = undefined; }
    return state;
  }
  async function download() {
    if (downloading) return downloading;
    if (disposed || installing || ['ready','waiting'].includes(state.status)) return state;
    if (state.status !== 'available') throw Error('请先检查是否有新版本');
    downloading = Promise.resolve().then(async () => {
      update({status:'downloading',percent:0,error:null}); progress(0);
      try {
        await updater.downloadUpdate();
        if (!disposed) { update({status:'ready',percent:100}); progress(-1); }
      } catch (error) { if (!disposed) failed(error); }
    });
    try { await downloading; } finally { downloading = undefined; }
    return state;
  }
  async function beginInstall() {
    if (installing || disposed) return state;
    stopWaiting(); installing = true; update({status:'installing',error:null});
    try {
      await beforeInstall();
      // Visible NSIS wizard with the same progress page as first installation.
      updater.quitAndInstall(false, true);
    } catch (error) { failed(error); }
    return state;
  }
  const poll = () => {
    waitTimer = schedule(async () => {
      try {
        const tasks = await getTasks();
        if (!waiting || disposed) return;
        if (!tasks.length) await beginInstall();
        else { update({status:'waiting',tasks}); poll(); }
      } catch (error) { if (waiting && !disposed) { update({error:error.message}); poll(); } }
    }, 1500);
    waitTimer?.unref?.();
  };
  async function install() {
    if (deciding || installing || disposed) return state;
    if (!['ready','waiting'].includes(state.status)) throw Error('更新尚未下载完成');
    const previous = state;
    deciding = true;
    update({status:'preparing',error:null});
    try {
      const tasks = await getTasks();
      const choice = tasks.length ? await confirmInstall(tasks) : 'now';
      if (choice === 'now') await beginInstall();
      else if (choice === 'wait') { stopWaiting(); waiting = true; update({status:'waiting',tasks,error:null}); poll(); }
      else update(previous);
    } catch (error) {
      update({...previous,error:error.message}); throw error;
    } finally { deciding = false; }
    return state;
  }
  function cancelInstall() { if (waiting) { stopWaiting(); update({status:'ready',tasks:[],error:null}); } return state; }
  return {check, download, install, cancelInstall, getState:() => state,
    dispose:() => { disposed = true; stopWaiting(); }};
}
