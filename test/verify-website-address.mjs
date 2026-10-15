import assert from 'node:assert/strict';
import { websiteAddress } from '../src/renderer/js/website-preview.mjs';

for (const [input, expected] of [
  ['example.com', 'https://example.com/'],
  [' https://example.com/path?q=1 ', 'https://example.com/path?q=1'],
  ['localhost:3000/test', 'http://localhost:3000/test'],
  ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
  ['[::1]:3000', 'http://[::1]:3000/'],
  ['example.com:8443/path', 'https://example.com:8443/path'],
]) assert.equal(websiteAddress(input), expected, input);
for (const input of ['', 'not a website', 'javascript:alert(1)', 'file:///C:/private', 'data:text/html,hello', 'ftp://example.com', 'https://user:password@example.com']) {
  assert.equal(websiteAddress(input), null, input);
}
console.log('PASS website address normalization, loopback ports and rejected non-web URLs/credentials');
