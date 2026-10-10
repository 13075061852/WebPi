// Local preparation only: never commits, tags, uploads or publishes a release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createGitHubCli} from './github-cli.mjs';
import {releaseRoot,releaseInputFingerprint,fileSha256,reusablePreflight} from './release-inputs.mjs';
import {verifyReleaseArtifacts} from './verify-release-artifacts.mjs';
import {verifyPackagedRelease} from './verify-packaged-release.mjs';

const run=promisify(execFile);
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const writeJson=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');};

export async function waitForExactCI({query,sha,wait=ms=>new Promise(r=>setTimeout(r,ms)),signal,timeout=20*60*1000,onState=()=>{}}){
  const started=Date.now();let last='';
  while(Date.now()-started<timeout){
    if(signal?.aborted)throw Error('CI wait stopped after local preparation failed');
    const runs=await query();
    const current=runs.find(item=>item.headSha===sha);
    const state=current?`${current.databaseId}:${current.status}:${current.conclusion}`:'waiting-for-CI';
    if(state!==last){onState(state);last=state;}
    if(current?.status==='completed'){
      if(current.conclusion!=='success')throw Error(`CI did not pass for ${sha}: ${current.conclusion} (${current.url})`);
      return current;
    }
    await wait(5000);
  }
  throw Error('Timed out waiting for CI for the exact release commit');
}

export async function reusableCandidate(state,fingerprint,files){
  if(state?.passed!==true || state.shippedFingerprint!==fingerprint || !Array.isArray(state.files) || state.files.length!==files.length)return false;
  for(const file of files){
    const saved=state.files.find(item=>item.file===file);
    if(!saved || !fs.existsSync(file) || saved.sha256!==await fileSha256(file))return false;
  }
  return true;
}

// Keep the successful candidate even if remote CI or a later verification fails.
export async function prepareConcurrently({local,ci}){
  const controller=new AbortController();
  let ciFailure;
  const ciWork=Promise.resolve().then(()=>ci(controller.signal)).catch(error=>{ciFailure=error;throw error;});
  const localWork=Promise.resolve().then(()=>local(()=>{if(ciFailure)throw ciFailure;})).catch(error=>{controller.abort();throw error;});
  const results=await Promise.allSettled([localWork,ciWork]);
  const failures=results.filter(result=>result.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Release preparation gates failed');
  return {local:results[0].value,ci:results[1].value};
}

async function runNode(args,root){
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(Error(`${args[0]} exited ${code}`)));
  });
}

export async function prepareLocalRelease({root=releaseRoot}={}){
  assert.equal(process.platform,'win32','Run the Windows release preparation on Windows');
  const reportFile=path.join(root,'test/results/release-local.json');
  const report={schema:1,passed:false,startedAt:new Date().toISOString(),stages:[]};
  writeJson(reportFile,report); // An old successful report must never survive a failed retry.
  const stage=async(name,action)=>{
    const started=Date.now();console.log(`RELEASE ${name}`);
    try{const value=await action();report.stages.push({name,passed:true,durationMs:Date.now()-started});writeJson(reportFile,report);return value;}
    catch(error){report.stages.push({name,passed:false,durationMs:Date.now()-started,error:error.message});writeJson(reportFile,report);throw error;}
  };
  try{
    const git=async(args)=>(await run('git',args,{cwd:root,windowsHide:true})).stdout.trim();
    assert.equal(await git(['status','--porcelain']), '','Commit the release inputs before starting preparation');
    assert.equal(await git(['branch','--show-current']),'main','Prepare the committed main branch');
    const sha=await git(['rev-parse','HEAD']);
    const pkg=readJson(path.join(root,'package.json')),lock=readJson(path.join(root,'package-lock.json'));
    assert.equal(pkg.version,lock.version);assert.equal(pkg.version,lock.packages[''].version);
    const repository='13075061852/WebPi';
    const gh=await stage('github-access',()=>createGitHubCli({root}));
    const remote=JSON.parse(await gh.call(['api',`repos/${repository}/commits/main`]));
    assert.equal(remote.sha,sha,'Push the release commit to main before starting preparation');
    const pages=JSON.parse(await gh.call(['api','--paginate','--slurp',`repos/${repository}/releases?per_page=100`]));
    assert.ok(!pages.flat().some(item=>item.tag_name==='v'+pkg.version && !item.draft),'This version is already public; use a new version for changed inputs');
    const inputFingerprint=await releaseInputFingerprint({root});
    const shippedFingerprint=await releaseInputFingerprint({root,kind:'shipped'});
    Object.assign(report,{commit:sha,version:pkg.version,inputFingerprint,shippedFingerprint});
    const result=await prepareConcurrently({
      ci:signal=>stage('ci',()=>waitForExactCI({sha,signal,query:async()=>JSON.parse(await gh.call(['run','list','--repo',repository,'--workflow','ci.yml','--commit',sha,'--limit','5','--json','databaseId,headSha,status,conclusion,url'])),onState:state=>console.log('CI '+state)})),
      local:async assertCiNotFailed=>{
        await stage('preflight',async()=>{
          const previous=readJson(path.join(root,'test/results/release-preflight.json'));
          if(reusablePreflight(previous,inputFingerprint)){console.log('REUSE unchanged successful preflight (<24h)');report.preflightReused=true;return;}
          await runNode(['scripts/release-preflight.mjs'],root);
          assert.ok(reusablePreflight(readJson(path.join(root,'test/results/release-preflight.json')),inputFingerprint),'Preflight report does not match current inputs');
        });
        assertCiNotFailed();
        const files=[`dist/Pi-Halo-Setup-${pkg.version}.exe`,`dist/Pi-Halo-Setup-${pkg.version}.exe.blockmap`,'dist/latest.yml','dist/win-unpacked/resources/app.asar'].map(file=>path.join(root,file));
        const candidateFile=path.join(root,'test/results/release-candidate.json');
        await stage('build',async()=>{
          if(await reusableCandidate(readJson(candidateFile),shippedFingerprint,files)){console.log('REUSE verified candidate hashes for unchanged shipped inputs');report.buildReused=true;return;}
          // A failed build invalidates the candidate marker but leaves prior files intact.
          writeJson(candidateFile,{passed:false});
          await runNode(['node_modules/electron-builder/out/cli/cli.js','--win','--publish','never'],root);
          assert.equal(await releaseInputFingerprint({root,kind:'shipped'}),shippedFingerprint,'Shipped inputs changed during build');
          const hashes=await Promise.all(files.map(async file=>({file,sha256:await fileSha256(file)})));
          writeJson(candidateFile,{passed:true,createdAt:new Date().toISOString(),version:pkg.version,shippedFingerprint,files:hashes});
        });
        assertCiNotFailed();
        const stageDirectory=path.join(os.tmpdir(),'halo-release-'+randomUUID());
        const artifacts=await stage('artifact-verification',()=>verifyReleaseArtifacts({directory:path.join(root,'dist'),stageDirectory}));
        await stage('packaged-checks',()=>verifyPackagedRelease({root,stagedExe:artifacts.stagedExe}));
        return artifacts;
      }
    });
    assert.equal(await releaseInputFingerprint({root}),inputFingerprint,'Release inputs changed during verification');
    assert.equal(await git(['rev-parse','HEAD']),sha,'The release commit changed during preparation');
    assert.equal(await git(['status','--porcelain']),'','Working tree changed during preparation');
    report.passed=true;report.ci=result.ci;report.artifacts=result.local;
    console.log(`READY ${pkg.version}: exact-commit CI, local checks and packaged checks passed. Candidate retained in dist.`);
    console.log('Next: create/push the new tag, then invoke scripts/upload-release.ps1 through scripts/Invoke-GitHub.ps1. This command does not publish.');
    return report;
  }catch(error){report.error=error.errors?.map(item=>item.message).join('; ')||error.message;throw error;}
  finally{report.finishedAt=new Date().toISOString();report.durationMs=Date.parse(report.finishedAt)-Date.parse(report.startedAt);writeJson(reportFile,report);}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--plan'))console.log('Committed/pushed main + GitHub access -> [exact-commit CI || preflight (fingerprint reuse) -> local build (candidate reuse) -> artifact verification -> 6 serial packaged checks] -> READY; no tag/upload/publication');
  else prepareLocalRelease().catch(error=>{console.error(error.errors?.map(item=>item.message).join('\n')||error.message);process.exitCode=1;});
}
