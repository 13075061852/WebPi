import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {waitForExactCI,reusableCandidate,prepareConcurrently} from '../scripts/release-local.mjs';
import {fileSha256} from '../scripts/release-inputs.mjs';

const sha='a'.repeat(40),other='b'.repeat(40);
const success={headSha:sha,databaseId:12,status:'completed',conclusion:'success',url:'https://example.invalid/ci'};
let queries=0,waits=0;
const found=await waitForExactCI({sha,query:async()=>++queries===1?[{...success,headSha:other}]:[success],wait:async()=>{waits++;}});
assert.equal(found,success);assert.equal(waits,1,'An unrelated successful commit cannot satisfy CI');
await assert.rejects(waitForExactCI({sha,query:async()=>[{...success,conclusion:'failure'}]}),/did not pass/);
await assert.rejects(waitForExactCI({sha,query:async()=>[{...success,conclusion:'cancelled'}]}),/did not pass/);
await assert.rejects(waitForExactCI({sha,query:async()=>[],timeout:0}),/Timed out/);
const aborted=new AbortController();aborted.abort();
await assert.rejects(waitForExactCI({sha,query:async()=>{throw Error('Should not query');},signal:aborted.signal}),/stopped/);

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const localGate=deferred(),ciGate=deferred(),started=[];
let done=false;
const pending=prepareConcurrently({local:async()=>{started.push('local');return localGate.promise;},ci:async()=>{started.push('ci');return ciGate.promise;}}).then(value=>{done=true;return value;});
await Promise.resolve();assert.deepEqual(started.sort(),['ci','local']);
localGate.resolve('verified candidate');await Promise.resolve();assert.equal(done,false,'CI remains a publication gate');
ciGate.resolve(success);assert.deepEqual(await pending,{local:'verified candidate',ci:success});

let savedCandidate=false;
await assert.rejects(prepareConcurrently({local:async()=>{savedCandidate=true;return 'retained';},ci:async()=>{throw Error('remote CI failed');}}),AggregateError);
assert.equal(savedCandidate,true,'CI failure does not erase a completed candidate');
let ciWasAborted=false;
await assert.rejects(prepareConcurrently({local:async()=>{throw Error('local failed');},ci:signal=>new Promise((_,reject)=>{
  signal.addEventListener('abort',()=>{ciWasAborted=true;reject(Error('cancelled wait'));},{once:true});
})}),AggregateError);
assert.equal(ciWasAborted,true,'Local failure must not leave a 20 minute CI wait running');
const ready=deferred(),failedCI=deferred();let builtAfterFailure=false;
const blocked=prepareConcurrently({local:async assertCiNotFailed=>{await ready.promise;assertCiNotFailed();builtAfterFailure=true;},ci:()=>failedCI.promise});
failedCI.reject(Error('failed'));
await new Promise(resolve=>setImmediate(resolve));
ready.resolve();
await assert.rejects(blocked,AggregateError);
assert.equal(builtAfterFailure,false,'Known CI failure must stop starting another expensive local stage');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-release-local-fixture-'));
try{
  const files=['setup.exe','setup.exe.blockmap','latest.yml','app.asar'].map(name=>path.join(dir,name));
  for(const file of files)fs.writeFileSync(file,path.basename(file));
  const state={passed:true,shippedFingerprint:'same',files:await Promise.all(files.map(async file=>({file,sha256:await fileSha256(file)})))};
  assert.equal(await reusableCandidate(state,'same',files),true);
  assert.equal(await reusableCandidate(state,'new-shipped-input',files),false);
  assert.equal(await reusableCandidate({...state,passed:false},'same',files),false);
  assert.equal(await reusableCandidate({...state,files:state.files.slice(1)},'same',files),false);
  fs.writeFileSync(files[0],'tampered');assert.equal(await reusableCandidate(state,'same',files),false);
  fs.unlinkSync(files[0]);assert.equal(await reusableCandidate(state,'same',files),false);
}finally{
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('halo-release-local-fixture-'));
  fs.rmSync(dir,{recursive:true,force:true});
}
console.log('PASS local release gates: exact commit CI, concurrent start, all-gate barrier, failure/abort, retained candidate and tamper detection; no build/upload');
