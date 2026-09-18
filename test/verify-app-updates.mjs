import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAppUpdates} from '../src/main/app-updates.mjs';
import {initAppUpdates} from '../src/renderer/js/app-updates.mjs';
const updater = new EventEmitter();
let available = true, fail = false, installs = 0, downloads = 0;
updater.checkForUpdates = async () => { if(fail) throw Error('offline'); if(available) updater.emit('update-available',{version:'1.0.2'}); };
updater.downloadUpdate = async () => { downloads++; updater.emit('download-progress',{percent:54}); if(fail) throw Error('checksum'); };
updater.quitAndInstall = () => { installs++; };
const states = [];
const service = createAppUpdates({updater, app:{isPackaged:true,getVersion:()=>'1.0.1'},emit:s=>states.push(s),getWindow:()=>null});
await service.check();
assert.equal(service.getState().status,'available');
assert.equal(downloads,0);
await service.download();
assert.equal(installs,1);
assert.ok(states.some(s=>s.percent===54));
assert.equal(updater.autoInstallOnAppQuit,false);
const failed = createAppUpdates({updater, app:{isPackaged:true,getVersion:()=>'1.0.1'},getWindow:()=>null});
await failed.check(); fail = true; await failed.download();
assert.equal(installs,1);
assert.equal(failed.getState().status,'error');
fail = false; available = false;
await failed.check(true); assert.equal(failed.getState().status,'current');
fail = true; await failed.check(); assert.equal(failed.getState().status,'current');
await failed.check(true); assert.equal(failed.getState().status,'error');
console.log('PASS update detection, explicit download, progress, automatic install, failed download protection and offline check');
const classes = new Set();
const button = {dataset:{},setAttribute(){},classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);}}};
let publish, resolveState, clicked = 0;
initAppUpdates({root:{querySelector:()=>button},api:{
  onAppUpdate: callback => {publish=callback;},
  appUpdateState:()=>new Promise(resolve=>{resolveState=resolve;}),
  downloadAppUpdate:()=>{clicked++;},checkAppUpdate:()=>{},
}});
publish({status:'available',version:'1.0.5',currentVersion:'1.0.4'});
assert.equal(button.textContent,'下载更新');
assert.ok(classes.has('update-attention')); assert.match(button.title,/1\.0\.5/);
assert.equal(clicked,0,'Discovery must not start a download');
resolveState({ok:true,data:{status:'idle'}}); await Promise.resolve();
assert.equal(button.textContent,'下载更新','Late initial state must not erase the update badge');
button.onclick(); assert.equal(clicked,1);
publish({status:'downloading',version:'1.0.5',percent:25});
assert.equal(button.disabled,true); assert.equal(button.textContent,'更新 25%');
publish({status:'current',version:null}); assert.equal(classes.has('update-attention'),false);
console.log('PASS update attention, explicit download action, progress, current state and initial state race');
