import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const nativeFrames = new Map(), listeners = new Map();
let sequence = 0, time = 0;
const running = { playState: 'running', pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; } };
const alreadyPaused = { playState: 'paused', play() { assert.fail('Page-owned paused animation must stay paused'); } };
const window = {
  requestAnimationFrame(callback) { if (typeof callback !== 'function') throw new TypeError('callback'); nativeFrames.set(++sequence, callback); return sequence; },
  cancelAnimationFrame(id) { nativeFrames.delete(id); },
  addEventListener(name, callback) { listeners.set(name, callback); },
};
const originalRAF = window.requestAnimationFrame;
const context = vm.createContext({ window, document: { getAnimations: () => [running, alreadyPaused] }, setTimeout, clearTimeout });
const code = fs.readFileSync('src/main/inject/preview-motion.js', 'utf8');
const pause = value => vm.runInContext(`(${code})(${value})`, context);
const tick = () => { const frames = [...nativeFrames]; nativeFrames.clear(); time += 16; for (const [, callback] of frames) callback(time); };
pause(false);
assert.equal(window.requestAnimationFrame, originalRAF, 'Unused previews must keep their native scheduler');
pause(true);
assert.equal(running.playState, 'paused');
let draws = 0, token;
function draw() { assert.equal(this, window); draws++; token = window.requestAnimationFrame(draw); }
token = window.requestAnimationFrame(draw);
tick(); assert.equal(draws, 0);
listeners.get('resize')(); listeners.get('resize')();
tick(); assert.equal(draws, 1, 'Resize draws the cleared canvas once without restarting its loop');
tick(); assert.equal(draws, 1);
pause(false); tick(); assert.equal(draws, 2); assert.equal(running.playState, 'running');
pause(true); tick(); assert.equal(draws, 2);
pause(false);
window.cancelAnimationFrame(token);
tick(); assert.equal(draws, 2, 'The original callback ID must still cancel after resume reschedules it');
pause(true);
const cancelled = window.requestAnimationFrame(() => assert.fail('Cancelled frame ran'));
window.cancelAnimationFrame(cancelled);
pause(false); tick();
assert.equal(nativeFrames.size, 0);
pause(true);
let sibling;
window.requestAnimationFrame(() => window.cancelAnimationFrame(sibling));
sibling = window.requestAnimationFrame(() => assert.fail('Cancelled sibling ran during a resize'));
listeners.get('resize')(); tick();
pause(false); tick();
assert.equal(nativeFrames.size, 0);
assert.throws(() => window.requestAnimationFrame(null), TypeError);
let settled = false;
const settle = vm.runInContext(`(${code})(true, true)`, context).then(() => { settled = true; });
assert.equal(settled, false);
tick(); await Promise.resolve(); assert.equal(settled, false, 'Preparing motion must allow a frame to paint');
tick(); await settle; assert.equal(settled, true); assert.equal(nativeFrames.size, 0);
// Hidden windows may stop producing frames; the bounded fence must still clean up.
await vm.runInContext(`(${code})(true, true)`, context);
assert.equal(nativeFrames.size, 0, 'Timed-out frame callbacks must be cancelled');
pause(false);
console.log('PASS preview pause/resume, resize paint, cancellation, existing paused animations and bounded paint fence');
