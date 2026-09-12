import fs from 'node:fs/promises';
import { build } from 'esbuild';
const out = 'src/renderer/vendor/office';
await fs.mkdir(out, { recursive: true });
for (const [pkg, file] of [['jszip', 'dist/jszip.min.js'], ['docx-preview', 'dist/docx-preview.min.js'], ['exceljs', 'dist/exceljs.min.js']]) {
  await fs.copyFile('node_modules/' + pkg + '/' + file, out + '/' + file.split('/').pop());
}
await build({entryPoints:['node_modules/pptx-preview/dist/pptx-preview.es.js'],bundle:true,platform:'browser',format:'iife',globalName:'pptxPreview',minify:true,outfile:out+'/pptx-preview.umd.js',legalComments:'eof'});
for (const pkg of ['jszip','docx-preview','exceljs','pptx-preview','echarts','zrender','lodash','tslib','uuid']) {
  const files = await fs.readdir('node_modules/' + pkg);
  for (const name of files.filter(n => /^(license|copying|notice)/i.test(n))) {
    if ((await fs.stat('node_modules/'+pkg+'/'+name)).isFile()) await fs.copyFile('node_modules/'+pkg+'/'+name,out+'/'+pkg+'-'+name+'.txt');
  }
}
