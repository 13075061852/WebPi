import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudflareService, runWrangler, wranglerPath } from '../src/main/cloudflare.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-cf-test-'));
fs.writeFileSync(path.join(root, 'wrangler.jsonc'), '{}');
const id = 'a'.repeat(32), calls = [];
let authorized = true, fail = false;
const service = new CloudflareService({ cwd: root, run: async (args, options) => {
  calls.push({args, options});
  if (args[0] === 'whoami') return {ok:true, output:JSON.stringify({loggedIn:authorized, email:'fixture@example.test', accounts:[{id,name:'Fixture'}], tokenPermissions:['secret']})};
  if (args[0] === 'deploy') {
    if (fail) return {ok:false};
    fs.writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({type:'deploy', worker_name:'test', targets:['https://test.fixture.workers.dev']})+'\n');
  }
  return {ok:true};
} });
assert.ok(fs.existsSync(wranglerPath()));
assert.equal((await service.status()).tokenPermissions, undefined);
assert.equal((await service.auth('login')).authorized, true);
const deployed = await service.deploy(root, {});
assert.deepEqual(deployed.urls, ['https://test.fixture.workers.dev']);
assert.equal(calls.find(call => call.args[0] === 'deploy').options.env.CLOUDFLARE_ACCOUNT_ID,id);
await assert.rejects(service.deploy(root,{config:path.join(root,'..','outside.json')}));
authorized = false;
await assert.rejects(service.deploy(root,{}), /先.*授权/);
authorized = true; fail = true;
await assert.rejects(service.deploy(root,{}), /部署失败/);
assert.equal(service.deploying.size,0);
// Exercise the actual bundled CLI without authenticating or publishing.
const result = await runWrangler(['--version'], {cwd:root});
assert.equal(result.ok,true);
assert.match(result.output,/4\./);
fs.unlinkSync(path.join(root,'wrangler.jsonc')); fs.rmdirSync(root);
console.log('PASS bundled Wrangler, auth state, deployment URL, account selection, failure and project boundaries');
