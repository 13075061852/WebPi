import assert from 'node:assert/strict';
import {PiBridge,HaloStore} from '../src/main/pi-bridge.mjs';
import {resolveImageCredential} from '../src/main/image-generation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'halo-image-runtime-'));
const bridge=new PiBridge(new HaloStore(path.join(dir,'settings.json')),{}, {sessionDir:path.join(dir,'sessions')});
try {
 await bridge.start(dir);
 const credential=await resolveImageCredential(bridge.modelRuntime);
 assert(credential.access && credential.accountId);
 const tool=bridge.session.getToolDefinition('image_generate');
 assert.equal(typeof tool?.execute,'function');
 // Exercise the registered callback without a billable request in normal runs.
 await assert.rejects(tool.execute('probe',{prompt:''}),/提示词/);
 if(process.argv.includes('--live')) {
   const result=await tool.execute('probe',{prompt:'专业写实健身摄影，竖版4:5构图，全身呈现健康成年健身者，深青绿色运动上衣、深灰运动裤、训练鞋，双手各自然持一只轻哑铃置于身体两侧，站姿稳定。真实人物，不要几何小人。简洁浅灰白色摄影棚背景，柔和自然光，四周留白，完整保留头部、手部和双脚。无文字、无水印。'});
   assert(fs.statSync(result.details.file).size>1000);
   console.log('LIVE IMAGE',result.details.file);
 }
 console.log('PASS actual Pi auth resolver and registered image tool');
}finally{await bridge.runtime?.dispose();}
process.exit(0);
