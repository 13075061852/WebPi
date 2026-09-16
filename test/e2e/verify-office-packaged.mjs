import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-office-packaged-'));
const app=process.env.HALO_PACKAGED_EXE ? path.dirname(path.resolve(process.env.HALO_PACKAGED_EXE)) : path.resolve('dist/win-unpacked'),asar=path.join(app,'resources/app.asar');
const run=args=>new Promise((resolve,reject)=>{
  const child=spawn(path.join(app,'Pi Halo.exe'),[path.join(asar,'src/main/office/worker.cjs')],{cwd:dir,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';const timer=setTimeout(()=>{child.kill();reject(Error('timeout'));},60000);
  child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});child.on('error',reject);
  child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(err||out));try{resolve(JSON.parse(out.slice(out.lastIndexOf('HALO_OFFICE_RESULT=')+19)));}catch{reject(Error(out+err));}});
  child.stdin.end(JSON.stringify(args));
});
for(const format of ['word','excel','powerpoint','pdf']){
  const result=await run({action:'run',script:path.join(asar,'assets/office-examples',format+'.cjs')});
  assert.ok(result.checks[0].bytes>1000);console.log('PASS packaged',format);
}
const result=await run({action:'render_pdf',file:path.join(dir,'output/report.pdf'),outputDir:path.join(dir,'preview')});
assert.ok(result.texts.join('').includes('项目报告'));console.log('PASS packaged PDF canvas rendering',result.images);
