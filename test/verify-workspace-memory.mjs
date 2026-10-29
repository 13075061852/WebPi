import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createWorkspaceMemory } from '../src/renderer/js/workspace-memory.mjs';

const source = fs.readFileSync('src/renderer/js/app.js', 'utf8');
const start = source.indexOf('async function restoreWorkspace()');
const code = source.slice(start, source.indexOf('\nfunction setConversationWaiting(', start));
for (const kind of ['conversation', 'draft', 'deleted', 'server']) {
  const original = { cwd: 'C:/saved', session: 'saved.jsonl', tab: 'git', ...(kind === 'draft' ? { draft: true } : {}), ...(kind === 'server' ? { serverId: 'server' } : {}) };
  let value = JSON.stringify(original);
  const storage = { getItem: () => value, setItem: (_key, next) => { value = next; } };
  const memory = createWorkspaceMemory(storage), calls = [];
  memory.remember({ ready: true, cwd: 'C:/default', sessionFile: 'default.jsonl' }, 'chat');
  assert.deepEqual(JSON.parse(value), original, 'Startup defaults cannot overwrite the previous selection');
  const S = { state: { ready: true, cwd: 'C:/default', messageCount: 2 }, sessions: [] };
  const reply = (method, state) => async () => { calls.push(method); return { ok: true, data: state }; };
  const context = vm.createContext({ S, workspaceMemory: memory, normPath: s => String(s || '').toLowerCase(),
    window: { halo: {
      useProject: reply('project', true),
      getState: reply('state', { ready: true, cwd: 'C:/saved', sessionFile: 'newest.jsonl', messageCount: 2 }),
      openSession: async file => { calls.push('open:' + file); return kind === 'deleted' ? { ok: false } : { ok: true, data: { ready: true, cwd: 'C:/saved', sessionFile: file, messageCount: 2, serverId: original.serverId } }; },
      newSession: reply('draft', { ready: true, cwd: 'C:/saved', messageCount: 0 }),
    } },
    document: { querySelector: selector => ({ click() { calls.push(selector); } }) },
    applyState: state => { S.state = state; memory.remember(state, 'chat'); },
    applyProjectReset() {}, loadTree() {}, loadSessions() {}, loadResources() {},
    restoreHistory() { calls.push('history'); }, saveWorkspace() { memory.remember(S.state, 'git'); },
  });
  vm.runInContext(code, context); await context.restoreWorkspace();
  assert.equal(S.state.cwd, original.cwd);
  assert.equal(S.state.sessionFile, kind === 'draft' ? undefined : kind === 'deleted' ? 'newest.jsonl' : 'saved.jsonl');
  assert.equal(JSON.parse(value).tab, 'git');
  assert.equal(calls.filter(c => c === 'history').length, 1);
  const opened = calls.filter(c => c.startsWith('open:')).length;
  await context.restoreWorkspace();
  assert.equal(calls.filter(c => c.startsWith('open:')).length, opened, 'Later refresh must not reopen the startup selection');
}
for (const text of ['broken', '"text"', 'null']) {
  const memory = createWorkspaceMemory({ getItem: () => text, setItem() {} });
  assert.equal(memory.initial(), null);
}
const blocked = createWorkspaceMemory({ getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
blocked.finish(); blocked.remember({ ready: true, cwd: 'C:/project' }, 'git');
console.log('PASS workspace startup overwrite guard, exact older conversation, draft, server, deleted fallback, tab and storage failures');
