import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {installedDependencyFingerprint,releaseInputFingerprint,reusablePreflight} from '../scripts/release-inputs.mjs';

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'halo-release-inputs-'));
const root=path.join(temporary,'repository');
let checks=0;
const mark=()=>checks++;
const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);return file;};
try{
  fs.mkdirSync(root);
  execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
  write('.gitignore','node_modules/\ntmp/\n');
  write('src/main.mjs','export const value=1;\n');
  write('test/check.mjs','fixture one\n');
  write('package.json','{"version":"1.0.0"}\n');
  write('package-lock.json','{"version":"1.0.0"}\n');
  write('node_modules/.package-lock.json','{"packages":{"fixture":{"version":"1.0.0"}}}\n');
  write('node_modules/fixture/package.json','{"version":"1.0.0"}\n');
  const native=write('node_modules/fixture/addon.node','native-1');
  const dependencyOptions={root};
  const first=await installedDependencyFingerprint(dependencyOptions);
  assert.equal(first.files,3);assert.equal(first.hashedFiles,3);assert.equal(first.cachedFiles,0);mark();
  const second=await installedDependencyFingerprint(dependencyOptions);
  assert.equal(second.fingerprint,first.fingerprint);assert.equal(second.hashedFiles,0);assert.equal(second.cachedFiles,3);mark();

  // Same version, size and restored mtime must still invalidate changed native
  // bytes: ctime/birthtime/inode identity are part of the cache key as well.
  const originalStat=fs.statSync(native);
  fs.writeFileSync(native,'native-2');
  fs.utimesSync(native,originalStat.atime,originalStat.mtime);
  const rebuilt=await installedDependencyFingerprint(dependencyOptions);
  assert.notEqual(rebuilt.fingerprint,first.fingerprint);assert.equal(rebuilt.hashedFiles,1);assert.equal(rebuilt.cachedFiles,2);mark();

  write('node_modules/fixture/extra.js','additional dependency file');
  const added=await installedDependencyFingerprint(dependencyOptions);
  assert.notEqual(added.fingerprint,rebuilt.fingerprint);assert.equal(added.files,4);assert.equal(added.hashedFiles,1);mark();
  fs.unlinkSync(path.join(root,'node_modules/fixture/extra.js'));
  const removed=await installedDependencyFingerprint(dependencyOptions);
  assert.equal(removed.fingerprint,rebuilt.fingerprint);assert.equal(removed.files,3);mark();

  // A damaged or expired cache loses its fast path, never its content check.
  const cacheFile=path.join(root,'tmp/release-dependency-fingerprints.json');
  fs.writeFileSync(cacheFile,'broken JSON');
  const repaired=await installedDependencyFingerprint(dependencyOptions);
  assert.equal(repaired.fingerprint,removed.fingerprint);assert.equal(repaired.hashedFiles,3);mark();
  const aged=JSON.parse(fs.readFileSync(cacheFile,'utf8'));
  for(const entry of Object.values(aged.entries))entry.hashedAt=Date.now()-25*60*60*1000;
  fs.writeFileSync(cacheFile,JSON.stringify(aged));
  const expired=await installedDependencyFingerprint(dependencyOptions);
  assert.equal(expired.fingerprint,removed.fingerprint);assert.equal(expired.hashedFiles,3);mark();

  const external=path.join(temporary,'external-package');fs.mkdirSync(external);
  const externalFile=path.join(external,'index.js');fs.writeFileSync(externalFile,'linked-one');
  const link=path.join(root,'node_modules/linked-package');
  fs.symlinkSync(external,link,process.platform==='win32'?'junction':'dir');
  const linked=await installedDependencyFingerprint(dependencyOptions);
  assert.notEqual(linked.fingerprint,expired.fingerprint);assert.equal(linked.files,4);mark();
  fs.writeFileSync(externalFile,'linked-two');
  const linkedChanged=await installedDependencyFingerprint(dependencyOptions);
  assert.notEqual(linkedChanged.fingerprint,linked.fingerprint);assert.equal(linkedChanged.hashedFiles,1);mark();
  const cycle=path.join(external,'dependencies');
  fs.symlinkSync(path.join(root,'node_modules'),cycle,process.platform==='win32'?'junction':'dir');
  const cyclic=await installedDependencyFingerprint(dependencyOptions);
  assert.notEqual(cyclic.fingerprint,linkedChanged.fingerprint);assert.equal(cyclic.files,4);mark();
  fs.unlinkSync(cycle);
  fs.unlinkSync(link);
  assert.equal((await installedDependencyFingerprint(dependencyOptions)).fingerprint,expired.fingerprint);mark();

  const shippedBefore=await releaseInputFingerprint({root,kind:'shipped'});
  const checksBefore=await releaseInputFingerprint({root});
  write('test/check.mjs','fixture two\n');
  assert.equal(await releaseInputFingerprint({root,kind:'shipped'}),shippedBefore);
  assert.notEqual(await releaseInputFingerprint({root}),checksBefore);mark();
  write('src/main.mjs','export const value=2;\n');
  const sourceChanged=await releaseInputFingerprint({root,kind:'shipped'});
  assert.notEqual(sourceChanged,shippedBefore);mark();
  write('node_modules/fixture/addon.node','native-3');
  assert.notEqual(await releaseInputFingerprint({root,kind:'shipped'}),sourceChanged);mark();

  const now=Date.now();
  const success={passed:true,inputFingerprint:'fixture',endInputFingerprint:'fixture',finishedAt:new Date(now-1000).toISOString()};
  assert.equal(reusablePreflight(success,'fixture',now),true);
  assert.equal(reusablePreflight({...success,endInputFingerprint:'changed'},'fixture',now),false);
  assert.equal(reusablePreflight({...success,endInputFingerprint:undefined},'fixture',now),false);
  assert.equal(reusablePreflight({...success,passed:false},'fixture',now),false);
  assert.equal(reusablePreflight(success,'other',now),false);
  assert.equal(reusablePreflight({...success,finishedAt:new Date(now-24*60*60*1000).toISOString()},'fixture',now),false);
  assert.equal(reusablePreflight({...success,finishedAt:new Date(now+1000).toISOString()},'fixture',now),false);mark();
  console.log(`PASS ${checks} release input checks: actual dependency bytes, stat cache, links, source/test separation and preflight freshness`);
}finally{
  const resolved=path.resolve(temporary);
  if(path.dirname(resolved)!==path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('halo-release-inputs-'))throw Error('Unsafe release input fixture cleanup');
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
