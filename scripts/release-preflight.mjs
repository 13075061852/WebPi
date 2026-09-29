import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
const eslint=path.join(path.dirname(require.resolve('eslint/package.json')),'bin/eslint.js');
const checks = [['scripts/check-syntax.mjs'],[eslint,'src','scripts','test','--max-warnings','0'],['scripts/test-regressions.mjs']];
// Catch policy and runner-environment failures before paying the installer build cost.
if (process.platform === 'win32') checks.push(
  ['test/e2e/e2e-packaged-proxy.mjs','--electron'],
  ['test/e2e/e2e-packaged-proxy.mjs','--electron','--expect-direct'],
  ['test/e2e/e2e-ui-motion.mjs'],
);
for(const args of checks) {
  const result=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true});
  if(result.error || result.status!==0) {process.exitCode=1;break;}
}
