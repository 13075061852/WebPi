import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { conversationHistory } from '../src/main/conversation-history.mjs';

const manager = SessionManager.inMemory('/isolated-history');
const user = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp });
const old = user('Earlier conversation must remain visible', 1);
const reply = { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }], timestamp: 2 };
const kept = user('Recent question', 3);
manager.appendMessage(old);
manager.appendMessage(reply);
const keptId = manager.appendMessage(kept);
manager.appendCompaction('Summary replacing earlier model context', keptId, 12000);
const context = manager.buildSessionContext().messages;
assert.ok(!context.includes(old), 'Real installed SDK must reproduce shortened model context');
const session = { sessionManager: manager, messages: context };
assert.deepEqual(conversationHistory(session), [old, reply, kept], 'UI restores the full branch after compaction');
assert.deepEqual(manager.buildSessionContext().messages, context, 'UI restoration cannot expand or modify model context');

const live = { role: 'assistant', content: [{ type: 'text', text: 'Live tail' }], timestamp: 4 };
session.messages = [...context, live];
assert.deepEqual(conversationHistory(session), [old, reply, kept, live], 'Event emitted before disk persistence remains visible');
manager.appendMessage(live);
assert.deepEqual(conversationHistory(session), [old, reply, kept, live], 'Persisted live tail appears only once');
manager.appendCompaction('Second summary', keptId, 14000);
session.messages = manager.buildSessionContext().messages;
assert.deepEqual(conversationHistory(session), [old, reply, kept, live], 'Repeated compaction cannot discard transcript');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-history-reopen-'));
try {
  const file = path.join(directory, 'compacted.jsonl');
  fs.writeFileSync(file, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const reopened = SessionManager.open(file);
  assert.deepEqual(conversationHistory({ sessionManager: reopened, messages: reopened.buildSessionContext().messages }),
    [old, reply, kept, live], 'Reopening a compacted session from disk preserves the full visible history');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }

manager.branch(keptId);
const alternate = user('Alternative branch', 5);
manager.appendMessage(alternate);
session.messages = manager.buildSessionContext().messages;
assert.deepEqual(conversationHistory(session), [old, reply, kept, alternate], 'Other branches must stay out of the selected transcript');
assert.deepEqual(conversationHistory({ messages: [old] }), [old], 'Legacy/offline runtimes keep their message fallback');
console.log('PASS real SDK compaction, complete transcript, unchanged model context, live persistence race and branch isolation');
