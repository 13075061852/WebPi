import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {releaseRoot} from './release-inputs.mjs';
const run=promisify(execFile);

// Credentials are held only in child-process environments, never in reports.
export async function createGitHubCli({root=releaseRoot,env=process.env}={}) {
  const candidates=[env.HALO_GH_PATH,'gh',path.join(root,'tmp/tools/gh/bin/gh.exe'),path.join(env.ProgramFiles||'C:/Program Files','GitHub CLI/gh.exe')].filter(Boolean);
  let executable;
  for(const file of candidates){
    if(file!=='gh' && !fs.existsSync(file))continue;
    try{await run(file,['--version'],{windowsHide:true,env,timeout:10000});executable=file;break;}catch{}
  }
  if(!executable)throw Error('GitHub CLI is missing. Install gh or set HALO_GH_PATH before building.');
  const childEnv={...env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'};
  const call=async(args)=>{
    const {stdout}=await run(executable,args,{cwd:root,env:childEnv,windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});
    return stdout.trim();
  };
  try{await call(['api','user','--jq','.login']);}
  catch{
    if(childEnv.GH_TOKEN || childEnv.GITHUB_TOKEN)throw Error('GitHub authentication failed. Check the configured token before building.');
    const credential=await new Promise((resolve,reject)=>{
      const child=execFile('git',['credential','fill'],{cwd:root,env:childEnv,windowsHide:true,timeout:10000},(error,stdout)=>error?reject(Error('No noninteractive GitHub credential is available.')):resolve(stdout));
      child.stdin.end('protocol=https\nhost=github.com\n\n');
    });
    childEnv.GH_TOKEN=credential.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9);
    if(!childEnv.GH_TOKEN)throw Error('No GitHub credential is available.');
    try{await call(['api','user','--jq','.login']);}catch{throw Error('GitHub authentication failed before the release started.');}
  }
  return {call};
}
