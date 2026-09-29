import assert from 'node:assert/strict';
import { GlobalProxy } from '../src/main/global-proxy.mjs';
import { WindowsSystemProxy, windowsProxyState } from '../src/main/windows-system-proxy.mjs';
let current = {flags:15,server:'old:8080',bypass:'<local>',script:'http://fixture.invalid/proxy.pac'};
const original = {...current}, calls = [];
let failWrite = false;
const system = new WindowsSystemProxy({run:async request => {
  calls.push(request.action);
  if (request.action === 'write') {
    current = {...request.state};
    if (failWrite) { failWrite = false; throw Error('simulated partial write'); }
  }
  return {...current};
}});
const store = {data:{}, set(key,value) { this.data[key] = value; }};
const proxy = new GlobalProxy(store, {system,applyNode:()=>({close:async()=>{}})});
assert.equal(calls.length,0,'startup must not write Windows settings');
assert.deepEqual((await proxy.read()).system,original);
await proxy.set({mode:'proxy',port:7890});
assert.deepEqual(current,windowsProxyState({mode:'proxy',port:7890}));
await proxy.set({mode:'direct',port:7890});
assert.deepEqual(current,{flags:1,server:'',bypass:'',script:''});
current = {...original}; failWrite = true;
await assert.rejects(proxy.set({mode:'proxy',port:7891}),/partial write/);
assert.deepEqual(current,original,'partial OS writes must restore all previous fields');
assert.equal(store.data.globalProxy.mode,'direct');
await Promise.all([proxy.set({mode:'proxy',port:7892}),proxy.set({mode:'direct',port:7892})]);
assert.equal(current.flags,1);
const bad = new WindowsSystemProxy({run:async()=>original});
await assert.rejects(bad.apply({mode:'direct'}),/未按预期/);
let failSession = true;
const session = {setProxy:async()=>{if(failSession){failSession=false;throw Error('session failure');}},closeAllConnections:async()=>{}};
proxy.sessions.add(session);
await assert.rejects(proxy.set({mode:'proxy',port:7893}),/切换失败/);
assert.equal(current.flags,1);
console.log('PASS Windows proxy transaction: no startup writes, PAC/WPAD clearing, partial-write rollback, readback verification, serialization and session-failure rollback');
