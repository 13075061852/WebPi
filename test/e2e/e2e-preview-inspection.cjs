const {app,BrowserWindow}=require('electron');
const http=require('node:http');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const fs=require('node:fs');
app.setPath('userData',fs.mkdtempSync(path.join(require('node:os').tmpdir(),'halo-preview-inspection-')));
let server,win;
let revision=1;
app.whenReady().then(async()=>{
 const modulePath=process.env.HALO_INSPECTION_MODULE||path.resolve('src/main/preview-inspection.mjs');
 const {inspectPreview}=await import(pathToFileURL(modulePath).href);
 server=http.createServer((req,res)=>{
  if(req.url==='/login'){res.setHeader('Set-Cookie','session=verified; HttpOnly; SameSite=Lax');res.end('logged in');return;}
  if(!req.headers.cookie?.includes('session=verified')){res.writeHead(303,{Location:'/login'});res.end();return;}
  res.setHeader('Cache-Control','public, max-age=3600');
  res.end('<html><title>Authenticated test service</title><body><h1>Live private table revision '+revision+'</h1><div id="rows" style="height:100px;overflow:auto"><div style="height:600px">Protected server rows</div></div></body></html>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 win=new BrowserWindow({show:true,width:850,height:650,webPreferences:{webviewTag:true,contextIsolation:true,nodeIntegration:false}});
 const attached=new Promise(r=>win.webContents.once('did-attach-webview',(_e,g)=>r(g)));
 await win.loadURL('data:text/html,<div id="pvBody"><webview style="width:800px;height:600px" src="'+url+'/login"></webview></div>');
 const guest=await attached;
 if(guest.isLoading())await new Promise(r=>guest.once('did-stop-loading',r));
 await guest.loadURL(url+'/nodes');
 await new Promise(r=>setTimeout(r,500));
 const options={target:'hk',context:{kind:'service',serverId:'hk',guestId:guest.id},guests:[guest],previews:[{id:'hk',url}],screenshot:true};
 const result=await inspectPreview(options);
 assert.match(result.content[0].text,/Live private table/);
 assert.ok(result.details.overflow.some(x=>x.id==='rows'));
 assert.equal(result.content[1].mimeType,'image/png');
 assert.ok(Buffer.from(result.content[1].data,'base64').length>1000);
 const anonymous=await fetch(url+'/nodes',{redirect:'manual'});assert.equal(anonymous.status,303);
 assert.ok(!result.content[0].text.includes('session=verified'));
 revision=2;
 const loaded=new Promise(r=>guest.once('did-finish-load',r));
 const source=fs.readFileSync('src/renderer/js/app.js','utf8');
 const refresh=source.slice(source.indexOf('function refreshCompletedPreview('),source.indexOf('const portKey ='));
 await win.webContents.executeJavaScript(`{let previewService={serverId:'hk'};${refresh};refreshCompletedPreview({event:{type:'agent_settled'},serverId:'hk',sessionId:'background'});}`);
 await loaded;
 const updated=await inspectPreview({...options,screenshot:false});
 assert.match(updated.content[0].text,/revision 2/);
 assert.equal(guest.getURL(),url+'/nodes');
 console.log('PASS renderer completion hook refreshes cached live page and preserves authenticated route');
 console.log('PASS real authenticated webview text, overflow and screenshot; anonymous request redirects; cookies stay private');
}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{win?.destroy();server?.close();app.exit(process.exitCode||0);});
