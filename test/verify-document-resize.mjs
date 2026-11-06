import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/renderer/js/document-viewer.js', 'utf8');
const start = source.indexOf('function fitDocumentToWidth(');
const end = source.indexOf('\n// Paginate at', start);
const frames = new Map(), windowListeners = new Map(), documentListeners = new Map();
let sequence = 0, observer, disconnected = false;
const content = { clientWidth: 656, scrollTop: 0 };
const surface = { style: {}, isConnected: true };
const context = vm.createContext({
  getComputedStyle: () => ({ paddingTop: '28', paddingLeft: '28', paddingRight: '28' }),
  requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence; },
  cancelAnimationFrame: id => frames.delete(id),
  ResizeObserver: class { constructor(fn) { observer = fn; } observe(node) { assert.equal(node, content); } disconnect() { disconnected = true; } },
  window: { addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name) },
  document: { addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name) },
});
vm.runInContext(source.slice(start, end), context);
const flush = () => { for (const [id, fn] of frames) { frames.delete(id); fn(); } };
const stop = context.fitDocumentToWidth(content, surface, () => 1200, Infinity);
assert.equal(surface.style.zoom, .5);
content.scrollTop = 328;
content.clientWidth = 1256;
observer(); windowListeners.get('resize')();
assert.equal(frames.size, 1, 'Resize events share one frame');
flush();
assert.equal(surface.style.zoom, 1);
assert.equal(content.scrollTop, 628, 'Keep the same point in the document after scaling');
content.clientWidth = 0;
observer(); flush();
assert.equal(surface.style.zoom, 1, 'Hidden documents do not acquire a zero scale');
content.clientWidth = 356;
documentListeners.get('visibilitychange')(); flush();
assert.equal(surface.style.zoom, .25, 'Revealed document adapts without reopening');
content.clientWidth = 656;
windowListeners.get('focus')(); flush();
assert.equal(surface.style.zoom, .5);
observer(); stop();
assert.equal(disconnected, true);
assert.equal(frames.size, 0);
assert.equal(windowListeners.size, 0);
assert.equal(documentListeners.size, 0);
const stopCapped = context.fitDocumentToWidth(content, surface, () => 300);
assert.equal(surface.style.zoom, 1, 'Word and sheets keep natural size when the viewport is wider');
stopCapped();
assert.doesNotMatch(source, /stopWordFit/, 'All document lifecycle cleanup uses the shared disposer');
console.log('PASS shared document fitting, frame coalescing, reading position, hidden/reveal/focus updates, scale cap and lifecycle cleanup');
