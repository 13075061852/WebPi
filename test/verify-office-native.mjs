import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {runOffice} from '../src/main/office/tools.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-full-office-'));console.log(dir);
for(const name of ['word','excel','powerpoint','pdf']) {
const t=Date.now();const made=await runOffice({action:'run',script:path.resolve('assets/office-examples/'+name+'.cjs')},dir);let file=made.checks[0].file;
if(name!=='pdf'){const r=await runOffice({action:'convert_pdf',file,outputDir:path.join(dir,name)},dir);file=r.file;await assert.rejects(runOffice({action:'convert_pdf',file:made.checks[0].file,outputDir:path.join(dir,name)},dir),/已存在/);}
const checked=await runOffice({action:'inspect',file},dir);assert.ok(checked.pages>0);const rendered=await runOffice({action:'render_pdf',file,outputDir:path.join(dir,name+'-pages')},dir);assert.equal(rendered.rendered,checked.pages);assert.ok(rendered.texts.join('').trim());console.log(JSON.stringify({name,ms:Date.now()-t,pages:checked.pages,images:rendered.images}));
}
