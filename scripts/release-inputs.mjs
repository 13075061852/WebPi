import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const run=promisify(execFile);
export const releaseRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shipped=['src','assets','build','package.json','package-lock.json'];
const checked=[...shipped,'scripts','test','.github','eslint.config.mjs','AGENTS.md','docs/RELEASING.md'];
const dependencyCacheAge=24*60*60*1000;
const metadata=stat=>[stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs,stat.birthtimeNs].map(String).join(':');

export async function fileSha256(file) {
  const hash=createHash('sha256');
  for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}

// Every installed file is enumerated and statted on every scan. Only hashing its
// bytes is cached, and only while all high-resolution identity/time fields match.
// Resolve directory links too: npm links and Windows junctions can hold runtime
// inputs outside node_modules. An ancestry set makes cyclic links finite.
export async function installedDependencyFingerprint({root=releaseRoot,
  cacheFile=path.join(root,'tmp/release-dependency-fingerprints.json'),now=Date.now()}={}) {
  const started=Date.now();
  const directory=path.resolve(root,'node_modules');
  const records=[],files=new Map(),nextEntries=Object.create(null);
  let previous;
  try{previous=JSON.parse(fs.readFileSync(cacheFile,'utf8'));}catch{}
  const cache=previous?.schema===1 && previous.root===directory && previous.entries && typeof previous.entries==='object'
    ? previous.entries : Object.create(null);
  const visit=(logical,physical,ancestors=new Set())=>{
    const stat=fs.lstatSync(physical,{bigint:true});
    if(stat.isSymbolicLink()){
      const target=fs.realpathSync(physical);
      records.push({kind:'link',path:logical,target,link:fs.readlinkSync(physical)});
      visit(logical,target,ancestors);
    }else if(stat.isDirectory()){
      const identity=`${stat.dev}:${stat.ino}:${fs.realpathSync(physical)}`;
      if(ancestors.has(identity)){records.push({kind:'cycle',path:logical});return;}
      records.push({kind:'directory',path:logical});
      const nextAncestors=new Set(ancestors);nextAncestors.add(identity);
      for(const name of fs.readdirSync(physical).sort())visit(logical?`${logical}/${name}`:name,path.join(physical,name),nextAncestors);
    }else if(stat.isFile()){
      records.push({kind:'file',path:logical,physical});
      if(!files.has(physical))files.set(physical,{signature:metadata(stat)});
    }else throw Error(`Unsupported installed dependency entry: ${physical}`);
  };
  if(fs.existsSync(directory))visit('',directory);
  else records.push({kind:'missing',path:''});

  let hashedFiles=0,cachedFiles=0;
  const pending=[...files.entries()];let cursor=0;
  await Promise.all(Array.from({length:Math.min(8,pending.length)},async()=>{
    while(cursor<pending.length){
      const [file,entry]=pending[cursor++],saved=cache[file];
      if(saved?.signature===entry.signature && /^[a-f0-9]{64}$/.test(saved.sha256)
        && Number.isFinite(saved.hashedAt) && now>=saved.hashedAt && now-saved.hashedAt<dependencyCacheAge){
        nextEntries[file]=saved;cachedFiles++;continue;
      }
      // Reject a file changed while hashing, instead of caching a mixed read.
      const digest=await fileSha256(file);
      if(metadata(fs.statSync(file,{bigint:true}))!==entry.signature)throw Error(`Installed dependency changed during fingerprinting: ${file}`);
      nextEntries[file]={signature:entry.signature,sha256:digest,hashedAt:now};hashedFiles++;
    }
  }));
  const hash=createHash('sha256');hash.update('installed-dependencies-v1\0');
  for(const record of records){
    const {physical,...identity}=record;
    hash.update(JSON.stringify(identity)+'\0');
    if(physical)hash.update(nextEntries[physical].sha256+'\0');
  }
  fs.mkdirSync(path.dirname(cacheFile),{recursive:true});
  const temporary=`${cacheFile}.${randomUUID()}.tmp`;
  try{
    fs.writeFileSync(temporary,JSON.stringify({schema:1,root:directory,entries:nextEntries}));
    fs.renameSync(temporary,cacheFile);
  }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return {fingerprint:hash.digest('hex'),files:files.size,hashedFiles,cachedFiles,durationMs:Date.now()-started};
}

export async function releaseInputFingerprint({root=releaseRoot,kind='checks'}={}) {
  if(!['checks','shipped'].includes(kind))throw Error('Unknown release fingerprint kind');
  const {stdout}=await run('git',['ls-files','--cached','--others','--exclude-standard','-z','--',...(kind==='shipped'?shipped:checked)],{cwd:root,windowsHide:true,maxBuffer:4*1024*1024});
  const hash=createHash('sha256');
  hash.update(JSON.stringify({schema:2,kind,platform:process.platform,arch:process.arch,node:process.version,os:os.release()}));
  const files=[...new Set(stdout.split('\0').filter(Boolean))].sort();
  for(const name of files){
    const file=path.join(root,name);
    hash.update(name+'\0');
    hash.update(fs.existsSync(file)?await fileSha256(file):'<missing>');
  }
  hash.update('dependencies\0'+(await installedDependencyFingerprint({root})).fingerprint);
  if(kind==='checks' && process.env.HALO_DOCUMENT_FONT){
    hash.update('font\0'+process.env.HALO_DOCUMENT_FONT);
    hash.update(await fileSha256(process.env.HALO_DOCUMENT_FONT));
  }
  return hash.digest('hex');
}
export function reusablePreflight(report,fingerprint,now=Date.now()) {
  const ended=Date.parse(report?.finishedAt);
  return report?.passed===true && report.inputFingerprint===fingerprint && report.endInputFingerprint===fingerprint
    && Number.isFinite(ended) && now>=ended && now-ended<24*60*60*1000;
}
