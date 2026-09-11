import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInsideWorkspace } from '../src/main/workspace-path.mjs';
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-boundary-'));
const root = path.join(fixture, 'project'), outside = path.join(fixture, 'project-other');
fs.mkdirSync(root); fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
fs.writeFileSync(path.join(outside, 'private.txt'), 'outside');
try {
  assert.equal(isInsideWorkspace(root, root), true);
  assert.equal(isInsideWorkspace(root, path.join(root, 'ok.txt')), true);
  assert.equal(isInsideWorkspace(root, path.join(outside, 'private.txt')), false);
  assert.equal(isInsideWorkspace(root, path.join(root, '..', 'project-other', 'private.txt')), false);
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(isInsideWorkspace(root, path.join(root, 'escape', 'private.txt')), false);
  fs.symlinkSync(root, path.join(fixture, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(isInsideWorkspace(path.join(fixture, 'alias'), path.join(fixture, 'alias', 'ok.txt')), true);
  if (process.platform === 'win32') assert.equal(isInsideWorkspace(root.toUpperCase(), path.join(root, 'ok.txt')), true);
  console.log('PASS project root, siblings, traversal, junction escape, project aliases and Windows path casing');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
