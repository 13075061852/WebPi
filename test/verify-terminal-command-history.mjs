import assert from 'node:assert/strict';
import { createTerminalCommandHistory } from '../src/renderer/js/terminal-command-history.mjs';

const subscriptions = {}, writes = [], commands = [];
let lines = [], cursorX = 5, cursorY = 0;
const row = (text, wrapped = false) => ({ length: 15, isWrapped: wrapped,
  getCell: index => ({ getChars: () => text[index] || '' }),
  translateToString: (trim, start = 0, end = 15) => {
    const value = text.padEnd(15).slice(start, end); return trim ? value.trimEnd() : value;
  } });
const buffer = { type: 'normal', baseY: 0, get cursorX() { return cursorX; }, get cursorY() { return cursorY; },
  get length() { return lines.length; }, getLine: index => lines[index] };
const subscribe = name => callback => { subscriptions[name] = callback; return { dispose() {} }; };
const term = { cols: 14, buffer: { normal: buffer, active: buffer },
  parser: { registerOscHandler: (_id, callback) => subscribe('osc')(callback) },
  onWriteParsed: subscribe('parsed'), onResize: subscribe('resize'),
  registerMarker: offset => ({ line: cursorY + offset, dispose() {} }) };
const history = createTerminalCommandHistory(term, { commands: ['echo remembered'], remember: text => commands.push(text), write: text => writes.push(text) });
const key = name => history.key({ type: 'keydown', key: name, preventDefault() {} });
lines = [row('C:\\p>')]; subscriptions.osc('9;C:\\p'); subscriptions.parsed();
// Resize exposes an unoccupied cell between physical wrapped rows. A real
// typed space must survive, while that padding must not become draft content.
lines = [row('C:\\p>unfinishe'), row('d draft', true)]; cursorY = 1; cursorX = 7;
term.cols = 15; key('ArrowUp');
assert.equal(writes.at(-1), '\x1b');
// The asynchronous repaint can move the prompt after the Escape was sent.
lines = [row(''), row('C:\\p>'), row('', true)]; cursorY = 1; cursorX = 5; subscriptions.parsed();
assert.equal(writes.at(-1), 'echo remembered');
lines = [row(''), row('C:\\p>echo reme'), row('mbered', true)]; cursorY = 2; cursorX = 6; subscriptions.parsed();
key('ArrowDown');
lines = [row(''), row('C:\\p>'), row('', true)]; cursorY = 1; cursorX = 5; subscriptions.parsed();
assert.equal(writes.at(-1), 'unfinished draft');
assert.deepEqual(commands, []);
history.dispose();
const early = createTerminalCommandHistory(term, { commands: ['echo remembered'], remember: text => commands.push(text), write: text => writes.push(text) });
// ConPTY may combine its first prompt repaint with input already typed by the
// user. The cursor no longer ends at '>', but history must already be active.
lines = [row('C:\\p>draft')]; cursorY = 0; cursorX = 10;
subscriptions.osc('9;C:\\p'); subscriptions.parsed();
early.key({ type: 'keydown', key: 'ArrowUp', preventDefault() {} });
assert.equal(writes.at(-1), '\x1b');
lines = [row('C:\\p>')]; cursorX = 5; subscriptions.parsed();
assert.equal(writes.at(-1), 'echo remembered');
lines = [row('C:\\p>echo reme'), row('mbered', true)]; cursorY = 1; cursorX = 6; subscriptions.parsed();
early.input('\r');
// A repaint can overwrite the old physical input row after Enter. Preserve the
// submitted text instead of reading the new prompt as the previous command.
lines = [row(''), row(''), row('C:\\p>')]; cursorY = 2; cursorX = 5; subscriptions.parsed();
assert.deepEqual(commands, []); // Consecutive duplicate remains deduplicated.
early.dispose();
console.log('PASS resized ConPTY wrapped padding, echo acknowledgement, history recall and unfinished draft spaces');
