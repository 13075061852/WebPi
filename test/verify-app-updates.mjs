import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAppUpdates} from '../src/main/app-updates.mjs';
import {initAppUpdates} from '../src/renderer/js/app-updates.mjs';
import {terminalUpdateTasks} from '../src/main/update-terminal-tasks.mjs';
import {createRequire} from 'node:module';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
{
 const {NsisUpdater}=createRequire(import.meta.url)('electron-updater/out/NsisUpdater.js');
 let installerArgs;
 const updater={installerPath:'C:/fixture/update.exe',downloadedUpdateHelper:{},
  spawnLog:async(_file,args)=>{installerArgs=args},dispatchError:error=>{throw error},_logger:{info(){}}};
 assert.equal(NsisUpdater.prototype.doInstall.call(updater,{isSilent:false,isForceRunAfter:true}),true);
 assert.deepEqual(installerArgs,['--updated','--force-run'],'Installed updater opens the normal NSIS progress UI without /S');
}
function fixture(options={}) {
 const updater=new EventEmitter(),states=[],order=[],timers=[];
 let downloads=0,checks=0,installs=0;
 updater.checkForUpdates=async()=>{checks++;updater.emit('update-available',{version:'1.0.16'});};
 updater.downloadUpdate=async()=>{downloads++;updater.emit('download-progress',{percent:54});};
 updater.quitAndInstall=(silent,run)=>{assert.equal(silent,false);assert.equal(run,true);installs++;order.push('install');};
 const service=createAppUpdates({updater,app:{isPackaged:true,getVersion:()=>'1.0.15'},getWindow:()=>null,emit:s=>states.push(s),
  schedule:fn=>{timers.push(fn);return fn},cancel:fn=>{const i=timers.indexOf(fn);if(i>=0)timers.splice(i,1)},...options});
 return {updater,states,order,timers,service,counts:()=>({checks,downloads,installs})};
}
{
 const f=fixture();await Promise.all([f.service.check(),f.service.check(),f.service.check()]);
 assert.deepEqual(f.counts(),{checks:1,downloads:1,installs:0});
 assert.equal(f.service.getState().status,'ready');assert.ok(f.states.some(s=>s.percent===54));
 assert.equal(f.updater.autoInstallOnAppQuit,false);
 await f.service.check();assert.equal(f.counts().downloads,1);
 await Promise.all([f.service.install(),f.service.install()]);assert.equal(f.counts().installs,1);
}
{
 const f=fixture();f.updater.downloadUpdate=async()=>{throw Error('checksum mismatch')};
 await f.service.check();assert.equal(f.service.getState().status,'error');assert.equal(f.counts().installs,0);
 await assert.rejects(f.service.install(),/尚未下载/);
 f.updater.checkForUpdates=async()=>{};await f.service.check();assert.equal(f.service.getState().status,'current');
 f.updater.checkForUpdates=async()=>{throw Error('offline')};
 await f.service.check();assert.equal(f.service.getState().status,'current');
 await f.service.check(true);assert.equal(f.service.getState().status,'error');
}
{
 let tasks=[{kind:'agent',name:'后台会话'},{kind:'terminal',name:'终端命令'}],choice='cancel';
 const f=fixture({getTasks:async()=>tasks,confirmInstall:async found=>{assert.equal(found.length,2);return choice;}});
 await f.service.check();await f.service.install();assert.equal(f.service.getState().status,'ready');
 choice='wait';await f.service.install();assert.equal(f.service.getState().status,'waiting');assert.equal(f.counts().installs,0);
 await f.timers.shift()();assert.equal(f.counts().installs,0);
 f.service.cancelInstall();assert.equal(f.timers.length,0);assert.equal(f.service.getState().status,'ready');
 await f.service.install();tasks=[];await f.timers.shift()();assert.equal(f.counts().installs,1);
}
{
 const gate=deferred(),order=[];
 const f=fixture({getTasks:async()=>[{name:'任务'}],confirmInstall:async()=> 'now',beforeInstall:async()=>{order.push('window-closed');await gate.promise;order.push('tasks-stopped');}});
 await f.service.check();const install=f.service.install();await new Promise(r=>setImmediate(r));
 assert.deepEqual(order,['window-closed']);assert.equal(f.counts().installs,0);
 gate.resolve();await install;assert.equal(f.counts().installs,1);assert.deepEqual(order,['window-closed','tasks-stopped']);
}
{
 let queryFails=false;
 const f=fixture({getTasks:async()=>{if(queryFails)throw Error('cannot inspect tasks');return [{name:'任务'}]},confirmInstall:async()=> 'wait'});
 await f.service.check();await f.service.install();queryFails=true;await f.timers.shift()();
 assert.equal(f.counts().installs,0);assert.equal(f.service.getState().status,'waiting');
 f.service.dispose();assert.equal(f.timers.length,0);
}
{
 let failed=0;
 const f=fixture({beforeInstall:async()=>{throw Error('cleanup failed')},onInstallError:()=>failed++});
 await f.service.check();await f.service.install();assert.equal(f.counts().installs,0);assert.equal(failed,1);
}
{
 const gate=deferred();let polling=false;
 const f=fixture({getTasks:async()=>polling?gate.promise:[{name:'任务'}],confirmInstall:async()=> 'wait'});
 await f.service.check();await f.service.install();polling=true;
 const pending=f.timers.shift()();f.service.cancelInstall();gate.resolve([]);await pending;
 assert.equal(f.counts().installs,0,'Cancelling while a task query is pending prevents late installation');
 assert.equal(f.service.getState().status,'ready');
}
{
 let failures=0;const f=fixture({onInstallError:()=>failures++});
 f.updater.quitAndInstall=()=>f.updater.emit('error',Error('Installer launch failed'));
 await f.service.check();await f.service.install();assert.equal(f.service.getState().status,'error');assert.equal(failures,1);
}
{
 const sessions=new Map([['idle',{cwd:'C:/idle',child:{pid:10}}],['busy',{cwd:'C:/busy',child:{pid:20}}]]);
 for(const platform of ['win32','linux']) {
  const result=await terminalUpdateTasks(sessions,{platform,query:async(_file,_args,options)=>{
   if(platform==='win32')assert.equal(options.windowsHide,true);
   return {stdout:platform==='win32'?'[20]':'1 20 99'};
  }});
  assert.equal(result.length,1);assert.match(result[0].name,/busy/);
 }
}
console.log('PASS automatic check/download without install, deduplication, offline/retry, all-task guard, wait/cancel, close-before-cleanup, visible wizard and terminal task detection');
const classes=new Set(),button={dataset:{},setAttribute(){},classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);}}};
let publish,resolveState,installs=0,cancels=0,checks=0;
const notices=[];
initAppUpdates({root:{querySelector:()=>button},notify:text=>notices.push(text),api:{
 onAppUpdate:cb=>{publish=cb},appUpdateState:()=>new Promise(resolve=>{resolveState=resolve}),
 installAppUpdate:async()=>{installs++},cancelAppUpdateInstall:async()=>{cancels++},checkAppUpdate:async()=>{checks++},downloadAppUpdate:async()=>{},
}});
publish({status:'downloading',version:'1.0.16',percent:25});assert.equal(button.textContent,'下载 25%');assert.equal(button.disabled,true);
resolveState({ok:true,data:{status:'idle'}});await Promise.resolve();assert.equal(button.textContent,'下载 25%');
publish({status:'ready',version:'1.0.16'});assert.equal(installs,0);assert.equal(button.textContent,'重启更新');assert.equal(notices.length,1);
await button.onclick();assert.equal(installs,1);publish({status:'ready',version:'1.0.16'});assert.equal(notices.length,1);
publish({status:'waiting',version:'1.0.16',tasks:[{}]});assert.equal(button.textContent,'取消等待');await button.onclick();assert.equal(cancels,1);
publish({status:'error',error:'offline'});await button.onclick();assert.equal(checks,1);
publish({status:'current'});assert.equal(classes.has('update-attention'),false);
console.log('PASS download status, one ready notification, explicit install, waiting cancellation, retry and initial-state races');
