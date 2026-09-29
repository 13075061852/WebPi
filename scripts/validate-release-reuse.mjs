import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export function validateReuse({run, jobs, repository, tag}) {
  assert.equal(run.repository?.full_name,repository,'Reuse must be from this repository');
  assert.equal(run.path,'.github/workflows/release.yml','Reuse must come from the release workflow');
  assert.match(run.head_sha,/^[a-f0-9]{40}$/,'Invalid source commit');
  assert.ok(jobs.some(job=>job.name==='build' && job.conclusion==='success'),'Source build must have succeeded');
  assert.ok(['push','workflow_dispatch'].includes(run.event),'Unexpected source event');
  assert.match(tag,/^v\d+\.\d+\.\d+$/,'Invalid release tag');
  return run.head_sha;
}
async function main() {
  const {REUSE_RUN:runId,GITHUB_REPOSITORY:repository,RELEASE_TAG:tag,GH_TOKEN:token}=process.env;
  assert.match(runId || '',/^\d+$/);
  assert.ok(token && repository);
  const get=async endpoint=>{
    const reply=await fetch(`https://api.github.com/repos/${repository}/${endpoint}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
    if(!reply.ok)throw Error(`GitHub API ${reply.status}`);
    return reply.json();
  };
  const [run,jobs]=await Promise.all([get(`actions/runs/${runId}`),get(`actions/runs/${runId}/jobs?filter=all&per_page=100`)]);
  const sha=validateReuse({run,jobs:jobs.jobs,repository,tag});
  execFileSync('git',['fetch','origin',sha],{stdio:'pipe'});
  const inputs=['src','assets','package.json','package-lock.json','build'];
  // Ignore test-only repairs; every shipped byte must still match both source run and tag.
  execFileSync('git',['diff','--exit-code',sha,'HEAD','--',...inputs],{stdio:'pipe'});
  execFileSync('git',['diff','--exit-code',tag,'HEAD','--',...inputs],{stdio:'pipe'});
  console.log(`Reuse validated: run ${runId}, source ${sha}; packaged verification remains required`);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
