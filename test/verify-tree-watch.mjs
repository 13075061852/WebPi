import assert from 'node:assert/strict';
import { shouldRefreshTree } from '../src/main/tree-watch.mjs';
for (const separator of ['/', '\\']) {
  for (const file of ['src/main.js', 'docs/中文.md', 'src/distinct.js']) assert.equal(shouldRefreshTree(file.replaceAll('/', separator)), true);
  for (const file of ['src/.hidden/config', 'node_modules/a/index.js', 'src/dist/generated.js', 'coverage/lcov.info', '.git/index']) assert.equal(shouldRefreshTree(file.replaceAll('/', separator)), false);
}
assert.equal(shouldRefreshTree(null), false);
assert.equal(shouldRefreshTree(Buffer.from('src/main.js')), true);
console.log('PASS Windows/POSIX watch paths, nested ignored/hidden directories and valid source notifications');
