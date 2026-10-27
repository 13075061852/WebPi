import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/renderer/js/app.js','utf8');
const start = source.indexOf('const compactingSessions ='), end = source.indexOf('async function send(', start);
assert.ok(start >= 0 && end > start, 'Compaction fixture must end before the send handler');
const code = source.slice(start, end);
for (const [response, expected] of [
  [{ok:false,error:'Nothing to compact (session too small)'},'当前上下文较短'],
  [{ok:false,error:'Already compacted'},'当前上下文已压缩'],
  [{ok:false,error:'Compaction cancelled'},'已取消'],
  [{ok:false,error:'Provider HTTP 401'},'401'],
  [{ok:true,data:{summary:'Fixture summary',tokensBefore:1000,estimatedTokensAfter:100}},'Fixture summary'],
]) {
  const nodes=[]; let resolve, calls=0;
  const context=vm.createContext({S:{state:{sessionId:'one'}}, document:{createElement:()=>{const classes=new Set(), attributes=new Map();const n={isConnected:true,
    classList:{add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)},
    setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key),getAttribute:key=>attributes.get(key),append(){}};nodes.push(n);return n;}},
    $:()=>({append(){}}),scrollDown(){},toast(){},applyState(){},
    window:{halo:{compact:()=>{calls++;return new Promise(r=>{resolve=r;});},getState:async()=>({ok:true,data:{sessionId:'one'}})}}});
  vm.runInContext(code,context);
  const running=context.compactConversation(); await context.compactConversation(); assert.equal(calls,1);
  assert.ok(nodes[0].classList.contains('is-compacting'));
  assert.equal(nodes[0].getAttribute('aria-busy'),'true');
  assert.match(nodes[2].textContent,/正在/); resolve(response); await running;
  assert.ok(nodes[2].textContent.includes(expected),nodes[2].textContent);
  assert.equal(nodes[0].classList.contains('is-compacting'),false);
  assert.equal(nodes[0].getAttribute('aria-busy'),undefined);
}
console.log('PASS compaction progress, duplicate suppression, actual success, small session, cancellation, provider error');
