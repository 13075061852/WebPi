import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const eslint=path.join(path.dirname(require.resolve('eslint/package.json')),'bin/eslint.js');
for(const args of [['scripts/check-syntax.mjs'],[eslint,'src','scripts','test','--max-warnings','0'],['scripts/test-regressions.mjs']]) {
  const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true});
  if(result.error || result.status!==0) {process.exitCode=1;break;}
}
