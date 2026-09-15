import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTrustedUIURL } from '../src/main/trusted-ui-url.mjs';
const source = fs.readFileSync('src/main/main.mjs', 'utf8');
const start = source.indexOf('  const trustedSender = ');
const end = source.indexOf('  const handle = ', start);
const DIST = process.cwd();
const frame = { url: pathToFileURL(path.join(DIST, 'src', 'renderer', 'index.html')).href };
const splashFrame = { url: pathToFileURL(path.join(DIST, 'src', 'renderer', 'splash.html')).href };
const contents = { mainFrame: frame }, splashContents = { mainFrame: splashFrame };
const context = vm.createContext({
  DIST, path, pathToFileURL, isTrustedUIURL,
  mainWin: { isDestroyed: () => false, webContents: contents },
  splashWin: { isDestroyed: () => false, webContents: splashContents },
});
vm.runInContext(source.slice(start, end) + '\nglobalThis.check = trustedSender;', context);
assert.equal(context.check({ sender: contents, senderFrame: frame }), true);
assert.equal(context.check({ sender: splashContents, senderFrame: splashFrame }, true), true);
assert.equal(context.check({ sender: splashContents, senderFrame: splashFrame }), false);
assert.equal(context.check({ sender: {}, senderFrame: frame }), false);
assert.equal(context.check({ sender: contents, senderFrame: { ...frame } }), false);
assert.equal(context.check({ sender: contents, senderFrame: null }), false);
frame.url = 'https://example.com/';
assert.equal(context.check({ sender: contents, senderFrame: frame }), false);
context.mainWin.isDestroyed = () => true;
assert.equal(context.check({ sender: contents, senderFrame: frame }), false);
console.log('PASS IPC trusted main/splash, rejected foreign contents, subframe, missing frame, navigation and destroyed window');
