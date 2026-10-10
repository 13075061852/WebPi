import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {releaseRoot} from './release-inputs.mjs';

export const packagedChecks=[['verify-packaged-runtimes.mjs'],['e2e-bundled-pi.mjs'],['verify-office-packaged.mjs'],
  ['e2e-packaged-proxy.mjs'],['e2e-packaged-proxy.mjs','--expect-direct'],['e2e-ui-motion.mjs']];

export async function verifyPackagedRelease({root=releaseRoot,stagedExe}={}) {
  if(!stagedExe)throw Error('A verified, extracted HALO_PACKAGED_EXE is required');
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'halo-package-checks-'));
  const system=process.env.SystemRoot||'C:/Windows';
  const env={SystemRoot:system,WINDIR:system,ComSpec:path.join(system,'System32/cmd.exe'),
    PATH:[path.dirname(process.execPath),path.join(system,'System32'),path.join(system,'System32/WindowsPowerShell/v1.0')].join(path.delimiter),
    HOME:sandbox,USERPROFILE:sandbox,APPDATA:path.join(sandbox,'roaming'),LOCALAPPDATA:path.join(sandbox,'local'),TEMP:sandbox,TMP:sandbox,
    PI_OFFLINE:'1',PI_CODING_AGENT_DIR:path.join(sandbox,'agent'),GH_CONFIG_DIR:path.join(sandbox,'gh'),
    GIT_CONFIG_GLOBAL:path.join(sandbox,'gitconfig'),GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GCM_CREDENTIAL_STORE:'plaintext',
    GCM_PLAINTEXT_STORE_PATH:path.join(sandbox,'gcm'),HALO_PACKAGED_EXE:stagedExe,WRANGLER_SEND_METRICS:'false'};
  if(process.env.HALO_DOCUMENT_FONT)env.HALO_DOCUMENT_FONT=process.env.HALO_DOCUMENT_FONT;
  for(const name of ['roaming','local','agent','gh','gcm'])fs.mkdirSync(path.join(sandbox,name));
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL,'');
  const results=[];
  try{
    // GUI checks intentionally stay serial: they may own the foreground window.
    for(const [file,...args] of packagedChecks){
      const start=Date.now();console.log(`RUN ${file} ${args.join(' ')}`);
      let error;
      const code=await new Promise(resolve=>{
        const child=spawn(process.execPath,[path.join(root,'test/e2e',file),...args],{cwd:root,env,stdio:'inherit',windowsHide:true});
        const timer=setTimeout(()=>{error='Timed out';child.kill();},300000);
        child.on('error',e=>{error=e.message;clearTimeout(timer);resolve(-1);});
        child.on('close',status=>{clearTimeout(timer);resolve(status);});
      });
      results.push({file,args,code,error,durationMs:Date.now()-start});
      if(code!==0 || error)throw Error(`Packaged check failed: ${file} ${args.join(' ')}`);
    }
    return results;
  }finally{
    fs.mkdirSync(path.join(root,'test/results'),{recursive:true});
    fs.writeFileSync(path.join(root,'test/results/packaged-release-checks.json'),JSON.stringify({at:new Date().toISOString(),stagedExe,isolated:true,results},null,2)+'\n');
    if(path.dirname(path.resolve(sandbox))!==path.resolve(os.tmpdir())||!path.basename(sandbox).startsWith('halo-package-checks-'))throw Error('Unsafe test cleanup');
    fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:10,retryDelay:300});
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=JSON.parse(fs.readFileSync(path.join(releaseRoot,'test/results/release-artifacts.json'),'utf8'));
  verifyPackagedRelease({stagedExe:process.env.HALO_PACKAGED_EXE||report.stagedExe}).then(()=>console.log('PACKAGED CHECKS 6/6')).catch(error=>{console.error(error.message);process.exitCode=1;});
}
