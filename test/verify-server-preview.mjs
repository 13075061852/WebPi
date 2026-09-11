import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {ServerManager} from '../src/main/servers.mjs';
const web=http.createServer((_req,res)=>res.end('remote project'));
await new Promise(r=>web.listen(0,'127.0.0.1',r));
const manager=new ServerManager({data:{servers:[]}}, x=>x,x=>x);
const client=new EventEmitter();
client.forwardOut=(_src,_port,host,port,callback)=>{const stream=net.connect(port,host,()=>callback(null,stream));stream.on('error',()=>{});};
client.end=()=>client.emit('close');
manager.clients.set('test',client);
try {
 const item={port:web.address().port,address:'127.0.0.1',protocol:'TCP'};
 const url=await manager.preview('test',item);
 assert.match(url,/^http:\/\/127\.0\.0\.1:/);
 assert.equal(await (await fetch(url)).text(),'remote project');
 assert.equal(await manager.preview('test',item),url);
 await assert.rejects(manager.preview('test',{...item,protocol:'UDP'}),/TCP/);
 manager.disconnect('test');
 assert.equal(manager.previews.size,0);
 console.log('PASS loopback port preview, reuse, UDP rejection and cleanup');
} finally {manager.dispose();web.closeAllConnections();web.close();}
