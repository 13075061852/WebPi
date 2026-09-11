import assert from 'node:assert/strict';
import net from 'node:net';
import { ServerManager } from '../src/main/servers.mjs';
const server=net.createServer(socket=>socket.end());
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const manager=new ServerManager({data:{servers:[{id:'local',host:'127.0.0.1',port}]}},()=>'',()=>'');
try {
 const [a,b]=await Promise.all([manager.latency('local'),manager.latency('local')]);
 assert.equal(a.status,'ok');assert.ok(a.ms>=1);assert.equal(a,b);
 assert.equal((await manager.latencies())[0].checkedAt,a.checkedAt);
 await new Promise(r=>server.close(r));
 assert.equal((await manager.latency("local")).status,"ok");
 assert.equal((await manager.latency('local',true)).status,'unreachable');
 console.log('PASS latency measurement, cached concurrent requests and unreachable state');
}finally{server.close();}
