import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/renderer/js/app.js','utf8');
const code = source.slice(source.indexOf('const compactingSessions ='),source.indexOf('async function send(queueMode'));
for (const [response, expected] of [
  [{ok:false,error:'Nothing to compact (session too small)'},'当前上下文较短'],
  [{ok:false,error:'Already compacted'},'当前上下文已压缩'],
  [{ok:false,error:'Compaction cancelled'},'已取消'],
  [{ok:false,error:'Provider HTTP 401'},'401'],
  [{ok:true,data:{summary:'Fixture summary',tokensBefore:1000,estimatedTokensAfter:100}},'Fixture summary'],
]) {
  const nodes=[]; let resolve, calls=0;
  const context=vm.createContext({S:{state:{sessionId:'one'}}, document:{createElement:()=>{const n={isConnected:true,setAttribute(){},append(){}};nodes.push(n);return n;}},
    $:()=>({append(){}}),scrollDown(){},toast(){},applyState(){},
    window:{halo:{compact:()=>{calls++;return new Promise(r=>{resolve=r;});},getState:async()=>({ok:true,data:{sessionId:'one'}})}}});
  vm.runInContext(code,context);
  const running=context.compactConversation(); await context.compactConversation(); assert.equal(calls,1);
  assert.match(nodes[2].textContent,/正在/); resolve(response); await running;
  assert.ok(nodes[2].textContent.includes(expected),nodes[2].textContent);
}
console.log('PASS compaction progress, duplicate suppression, actual success, small session, cancellation, provider error');
