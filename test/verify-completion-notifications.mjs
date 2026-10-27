import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createCompletionNotifications } from '../src/main/completion-notifications.mjs';
import { isolatePi } from './helpers/isolated-pi.mjs';

const notifications = [];
let supported = true, enabled = true, focuses = 0;
class FakeNotification extends EventEmitter {
  static isSupported() { return supported; }
  constructor(options) { super(); this.options = options; notifications.push(this); }
  show() { this.shown = true; }
}
const service = createCompletionNotifications({ Notification: FakeNotification, enabled: () => enabled, focusWindow: () => focuses++ });
const dispatch = (sessionId, event) => service.observe('pi:event', { sessionId, event });
const begin = (id, text = '机密正文') => {
  dispatch(id, { type:'agent_start' });
  dispatch(id, { type:'message_start', message:{ role:'user', content:text } });
};
const answer = (id, stopReason) => dispatch(id, { type:'message_end', message:{ role:'assistant', stopReason, content:'机密回答' } });
const settle = (id, aborted = false) => dispatch(id, { type:'agent_settled', aborted });

begin('A'); answer('A', 'toolUse');
dispatch('A', { type:'agent_end', willRetry:true });
dispatch('A', { type:'agent_start' }); // Retry is still one logical run.
answer('A', 'error');
dispatch('A', { type:'agent_end', willRetry:true });
dispatch('A', { type:'agent_start' });
answer('A', 'stop');
assert.equal(notifications.length, 0, 'no notification during tools, retries, or streaming');
settle('A'); settle('A');
assert.equal(notifications.length, 1, 'one notification after settling, even with repeated events');
assert.equal(notifications[0].options.title, 'AI 回复已完成');
assert.equal(notifications[0].shown, true);
assert.doesNotMatch(JSON.stringify(notifications[0].options), /机密/);
notifications[0].emit('click');
assert.equal(focuses, 1);

begin('A'); begin('B');
answer('B', 'stop'); settle('B');
assert.equal(notifications.length, 2, 'background sessions notify independently');
answer('A', 'error'); settle('A');
assert.equal(notifications.at(-1).options.title, 'AI 回复未完成');
begin('C'); answer('C', 'length'); settle('C');
assert.equal(notifications.at(-1).options.title, 'AI 回复未完成');
const beforeAbort = notifications.length;
begin('D'); answer('D', 'aborted'); settle('D', true);
begin('E'); answer('E', 'stop'); settle('E', true);
dispatch('F', { type:'agent_start' }); answer('F', 'stop'); settle('F');
begin('G'); answer('G', 'toolUse'); settle('G');
assert.equal(notifications.length, beforeAbort, 'aborted, empty and unfinished tool turns do not notify');
supported = false; begin('H'); answer('H', 'stop'); settle('H');
supported = true; enabled = false; begin('I'); answer('I', 'stop'); settle('I');
assert.equal(notifications.length, beforeAbort, 'unsupported or closing application does not notify');
enabled = true;

// A real bridge dispatches all sessions to the same main-process observer.
const fixture = isolatePi('halo-notification-');
try {
  const { PiBridge, HaloStore } = await import('../src/main/pi-bridge.mjs');
  const project = path.join(fixture.dir, 'project'); fs.mkdirSync(project);
  const bridge = new PiBridge(new HaloStore(path.join(fixture.dir, 'settings.json')), {},
    { sessionDir:path.join(fixture.dir, 'sessions') });
  try {
    await bridge.start(project);
    bridge.onEvent(service.observe);
    const session = bridge.session;
    session.emit({ type:'agent_start' });
    session.emit({ type:'message_start', message:{ role:'user', timestamp:Date.now(), content:'hello' } });
    session.emit({ type:'message_end', message:{ role:'assistant', stopReason:'stop', content:[] } });
    session.emit({ type:'agent_settled', aborted:false });
    assert.equal(notifications.length, beforeAbort + 1);
    assert.equal(notifications.at(-1).options.title, 'AI 回复已完成');
  } finally { await bridge.dispose(); }
} finally { fixture.cleanup(); }
console.log('PASS completion notifications, retry/abort handling, background sessions, privacy and real bridge events');
