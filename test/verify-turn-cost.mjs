import assert from 'node:assert/strict';
import { TurnCost } from '../src/renderer/js/turn-cost.mjs';
import { refreshBillingFx } from '../src/main/billing-fx.mjs';
const msg = {provider:'deepseek',model:'deepseek-flash',timestamp:Date.parse('2026-09-18T02:00:00Z'),usage:{input:1000,cacheRead:1000,output:1000,cost:{total:99}}};
const turn = new TurnCost(); turn.add(msg); turn.add({...msg});
assert.equal(turn.format().text,'约 ¥0.0100');
turn.add({...msg,timestamp:Date.parse('2026-09-19T02:00:00Z')});
assert.equal(turn.format().text,'约 ¥0.0151');
turn.add({provider:'openai',model:'gpt-fixture',usage:{cost:{total:.05}}});
assert.equal(turn.format().text,'约 ¥0.0151 + $0.0500');
const subscription = new TurnCost(); subscription.add({provider:'openai-codex',usage:{cost:{total:5}}});
assert.equal(subscription.format().text,'订阅用量');
const domestic = new TurnCost(); domestic.add({provider:'moonshotai-cn',usage:{cost:{total:.1}}});
assert.equal(domestic.format().text,'部分费用未提供');
assert.equal(domestic.format({rate:7,date:'2026-09-18'}).text,'约 ¥0.7000');
const missing = new TurnCost(); missing.add({provider:'custom',usage:{cost:{total:0}}});
assert.equal(missing.format().text,'部分费用未提供');
const partial = new TurnCost(); partial.add({...msg,__partial:true}); assert.equal(partial.messages.size,0);
const old = new TurnCost(); old.add({...msg,timestamp:Date.parse('2026-05-01')});
assert.equal(old.format({rate:7,date:'2026-09-18'}).text,'约 ¥693.0000','Historical calls must not use current native tariff');
const fetchOriginal=globalThis.fetch;
const offline=process.env.PI_OFFLINE;
try {
  delete process.env.PI_OFFLINE; // All requests below are intercepted by this fixture.
  let calls=0; globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({date:'2026-09-18',rates:{CNY:7}})};};
  const store={data:{},set(key,value){this.data[key]=value;}};
  assert.equal((await refreshBillingFx(store)).rate,7);
  await refreshBillingFx(store); assert.equal(calls,1);
  store.data.billingFx.fetchedAt=0;
  globalThis.fetch=async()=>{throw Error('offline');};
  assert.equal((await refreshBillingFx(store)).rate,7);
} finally {globalThis.fetch=fetchOriginal;if(offline===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=offline;}
console.log('PASS per-turn costs: dedup, peak/off-peak, mixed currencies, subscription, unknown, historical pricing, cached FX');
