import {app,BrowserWindow} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAppUpdates} from '../../src/main/app-updates.mjs';
import {TerminalPool} from '../../src/main/terminal-pool.mjs';
import {terminalUpdateTasks} from '../../src/main/update-terminal-tasks.mjs';
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'halo-update-ui-')));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 if(process.platform==='win32') {
  const pool=new TerminalPool(()=>{});
  try {
   pool.start({id:'update-probe',cwd:app.getPath('userData')});
   await new Promise(resolve=>setTimeout(resolve,250));
   assert.equal((await terminalUpdateTasks(pool.sessions)).length,0,'An idle terminal must not block updating');
   pool.write({id:'update-probe',data:'ping -n 7 127.0.0.1 >nul\r'});
   await new Promise(resolve=>setTimeout(resolve,250));
   assert.equal((await terminalUpdateTasks(pool.sessions)).length,1,'A running terminal command blocks automatic installation');
   pool.write({id:'update-probe',data:'\x03'});
   await new Promise(resolve=>setTimeout(resolve,500));
   assert.equal((await terminalUpdateTasks(pool.sessions)).length,0);
   console.log('PASS real ConPTY: idle shell is ignored, running command detected, completion clears the update guard');
  }finally{await pool.dispose()}
 }
 const win=new BrowserWindow({show:true,width:600,height:400});
 try {
  await win.loadURL('data:text/html,<h1>Active task</h1>');
  const source=fs.readFileSync('src/main/main.mjs','utf8').replaceAll('\r\n','\n');
  const start=source.indexOf('beforeInstall: async () => {')+'beforeInstall: '.length;
  const end=source.indexOf(',\n    onInstallError:',start);
  assert.ok(start>0&&end>start);
  let release,installed=0,saved=0,disposed=0;
  const gate=new Promise(resolve=>{release=resolve});
  const context={updateClosing:false,quitting:false,mainWin:win,splashWin:null,store:{set:()=>{saved++}},
   startup:{dispose(){}},clearTimeout,startupWatchdog:null,disarmTreeWatcher(){},terminals:{dispose(){}},environmentRepairCancelled:false,
   bridge:{stopForUpdate:()=>gate,dispose:async()=>{disposed++}},environmentRepairBridge:null,environment:{job:null},projectShutdownDone:false};
  const beforeInstall=vm.runInNewContext('('+source.slice(start,end)+')',context);
  const updater=new EventEmitter();
  updater.checkForUpdates=async()=>{updater.emit('update-available',{version:'99.0.0'})};
  updater.downloadUpdate=async()=>{};
  updater.quitAndInstall=(silent,run)=>{assert.equal(silent,false);assert.equal(run,true);assert.ok(win.isDestroyed());installed++};
  const service=createAppUpdates({updater,app:{isPackaged:true,getVersion:()=>'1.0.15'},getWindow:()=>win,beforeInstall,
   getTasks:async()=>[{name:'Foreground task'},{name:'Background task'}],confirmInstall:async()=> 'now'});
  await service.check();assert.equal(installed,0,'Automatic download does not install');
  const install=service.install();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(win.isDestroyed(),'Main window closes before waiting for task cleanup');
  assert.equal(installed,0);assert.equal(saved,1);assert.equal(context.updateClosing,true);
  release();await install;assert.equal(installed,1);assert.equal(disposed,1);assert.equal(context.projectShutdownDone,true);
  console.log('PASS real window closes before blocked cleanup; geometry saved, task cleanup completes, visible installer requested once; no real install');
 }finally{if(!win.isDestroyed())win.destroy();app.quit();}
}).catch(error=>{console.error(error);app.exit(1)});
