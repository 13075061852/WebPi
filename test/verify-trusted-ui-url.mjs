import assert from 'node:assert/strict';
import { isTrustedUIURL } from '../src/main/trusted-ui-url.mjs';
const expected = 'file:///c:/Users/Example/WebPi/src/renderer/index.html';
assert.equal(isTrustedUIURL('file:///C:/users/example/webpi/src/renderer/index.html', expected, 'win32'), true);
assert.equal(isTrustedUIURL('file:///C:/users/example/webpi/src/renderer/index.html', expected, 'linux'), false);
for (const url of ['https://example.com/index.html', expected + '?x=1', expected + '#x', expected.replace('index.html', 'document-viewer.html'), 'file:///c:/other/index.html', undefined]) {
  assert.equal(isTrustedUIURL(url, expected, 'win32'), false);
}
assert.equal(isTrustedUIURL(expected, expected, 'linux'), true);
console.log('Trusted UI URL checks passed');
