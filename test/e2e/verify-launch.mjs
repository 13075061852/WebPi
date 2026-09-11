import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const child = spawn('node_modules/electron/dist/electron.exe', ['.', '--remote-debugging-port=9348', '--user-data-dir=' + mkdtempSync(path.join(tmpdir(), 'halo-launch-'))], {stdio:'ignore'});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let ws;
try {
 let page;
 for(let i=0;i<100;i++) {
  try { page=(await (await fetch('http://127.0.0.1:9348/json')).json()).find(p=>p.url.endsWith('splash.html')); } catch {}
  if(page) break; await sleep(50);
 }
 if(!page) throw Error('Splash missing');
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise(r=>ws.onopen=r);
 let id=0; const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id) {pending.get(m.id)?.(m);pending.delete(m.id);}};
 const send=(method,params={})=>new Promise(r=>{pending.set(++id,r);ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true})).result?.result?.value;
 await sleep(650);
 const initial=await evaluate(`(()=>{const s=document.querySelector('#stage'),r=s.getBoundingClientRect();return {width:r.width,radius:getComputedStyle(s).borderRadius,center:r.x+r.width/2,viewport:innerWidth}})()`);
 if(initial.radius!=='24px' || Math.abs(initial.center-initial.viewport/2)>2) throw Error(JSON.stringify(initial));
 writeFileSync('test/shot-launch.png',Buffer.from((await send('Page.captureScreenshot')).result.data,'base64'));
 let expanded=false;
 for(let i=0;i<100;i++) {
  expanded=await evaluate(`document.querySelector('#stage').classList.contains('expand')`);
  if(expanded) break; await sleep(25);
 }
 if(!expanded) throw Error('No expand transition');
 await sleep(140);
 const middle=await evaluate(`(()=>{const r=document.querySelector('#stage').getBoundingClientRect();return {width:r.width,center:r.x+r.width/2,viewport:innerWidth}})()`);
 if(middle.width<=initial.width || Math.abs(middle.center-middle.viewport/2)>2) throw Error(JSON.stringify(middle));
 writeFileSync('test/shot-launch-expand.png',Buffer.from((await send('Page.captureScreenshot')).result.data,'base64'));
 console.log('LAUNCH PASS',JSON.stringify({initial,middle}));
 await sleep(1100);
} finally { ws?.close(); child.kill(); }
