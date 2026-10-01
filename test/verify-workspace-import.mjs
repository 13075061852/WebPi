import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importWorkspaceFiles } from '../src/main/workspace-import.mjs';
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-import-'));
try {
  const root = path.join(fixture,'project'), outside = path.join(fixture,'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  const source = path.join(outside,'报告.pdf'); await fs.writeFile(source,'original');
  const first = await importWorkspaceFiles(root,root,[source]);
  assert.equal(await fs.readFile(first.imported[0],'utf8'),'original');
  await fs.writeFile(first.imported[0],'existing');
  const second = await importWorkspaceFiles(root,root,[source]);
  assert.equal(path.basename(second.imported[0]),'报告 (1).pdf');
  assert.equal(await fs.readFile(first.imported[0],'utf8'),'existing');
  assert.equal(await fs.readFile(source,'utf8'),'original');
  await assert.rejects(importWorkspaceFiles(root,outside,[source]),/当前项目/);
  const mixed = await importWorkspaceFiles(root,root,[outside,path.join(outside,'missing'),source]);
  assert.equal(mixed.failed.length,2); assert.equal(mixed.imported.length,1);
  const same = await importWorkspaceFiles(root,root,[first.imported[0]]);
  assert.equal(same.imported.length,0);
  console.log('PASS file import preserves sources, avoids overwrite, isolates project and handles partial failures');
} finally { await fs.rm(fixture,{recursive:true,force:true}); }
