import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOffice } from '../src/main/office/tools.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-office-'));
const root=process.cwd();
console.log('OFFICE_FIXTURE',dir);
const status=await runOffice({action:'status'},dir);assert.equal(status.formats.length,4);
for(const format of ['word','excel','powerpoint','pdf']) {
  const result=await runOffice({action:'run',script:path.join(root,'assets/office-examples',format+'.cjs')},dir);
  assert.equal(result.checks.length,1);assert.ok(result.checks[0].bytes>1000);
  if(format==='excel')assert.deepEqual(result.checks[0].formulaWarnings,[]);
  if(format==='powerpoint')assert.equal(result.checks[0].slides,3);
  console.log('PASS',format,result.checks[0].bytes);
}
const rendered=await runOffice({action:'render_pdf',file:path.join(dir,'output/report.pdf'),outputDir:path.join(dir,'preview')},dir);
assert.ok(rendered.images.length>0);assert.ok(rendered.texts.join('').includes('项目报告'));
console.log('PASS PDF rendering and Chinese text',JSON.stringify({pages:rendered.pages,images:rendered.images}));
