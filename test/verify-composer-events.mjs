import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { userMessageParts, userMessageText } from '../src/renderer/js/user-message.mjs';

const source = fs.readFileSync('src/renderer/js/app.js', 'utf8').replaceAll('\r\n', '\n');
function extract(start, end) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, start);
  return source.slice(begin, finish);
}
function node() {
  return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, focus() {}, value: '', scrollHeight: 24, innerHTML: '' };
}
function harness() {
  const input = node(), attachments = node(), messages = node(), calls = [], rows = [], order = [], notices = [];
  const S = { state: { ready: true, sessionId: 'A', cwd: 'C:/project' }, sessionSwitchSeq: 0,
    switchingSession: false, streaming: false, images: [], files: [], composerRevision: 0, toolCards: new Map(),
    queued: { steering: [], followUp: [] } };
  const invoke = (method, ...args) => new Promise((resolve, reject) => calls.push({ method, args, resolve, reject }));
  const context = vm.createContext({
    S, Map, Date, compactingSessions: new Set(), userMessageParts, userMessageText,
    $: selector => ({ '#input': input, '#attachRow': attachments, '#messages': messages, '#projList': node() })[selector] || node(),
    $$: () => [], document: { createElement: node },
    window: { __piDebug: { ignored: 0 }, halo: Object.fromEntries(['prompt', 'steer', 'followUp', 'projectAdd'].map(method => [method, (...args) => invoke(method, ...args)])) },
    currentPreviewContext: () => null, toPiImage: img => ({ type: 'image', mimeType: img.mediaType, data: img.data }),
    esc: x => x, trunc: x => x, openImagePreview() {}, closeMentions() {},
    renderUserMsg: (text, images) => { rows.push({ text: userMessageText(text), images }); order.push('user'); },
    finalizeMessage: () => order.push('message-end'), finalizeTurn: () => order.push('turn-end'),
    ensureTurn: () => { order.push('turn-start'); return {}; }, collapseThink() {},
    setStreamingUI: value => { S.streaming = value; },
    applyState: state => { S.state = state; }, scrollDown() {},
    requestAnimationFrame: callback => setImmediate(callback),
    toast: message => notices.push(message), refreshSessionsDebounced() {},
    loadTree: async () => {}, loadSessions: async () => {}, loadResources: async () => {}, loadProjects: async () => {},
    applyProjectReset() {}, saveWorkspace() {},
  });
  for (const [start, end] of [
    ['async function send(', '\nfunction renderUserMsg('],
    ['function addFileAttachment(', '\nfunction addImageFile('],
    ['function onMessageStart(', '\nfunction onMessageUpdate('],
    ['async function retryLast()', '\n/* ---- tool timeline'],
    ['function renderAttachments()', '\n/* ---- project'],
    ['function autoGrow()', '\nfunction scrollDown('],
    ['let pendingSessionEvents =', '\nasync function refreshState()'],
    ['function finishSessionSwitch()', '\nfunction clearChat()'],
    ['async function restoreHistory(', '\n/* ============================================================\n   sessions'],
    ['async function switchProjectViaAdd(', '\n/* ---- 项目'],
  ]) vm.runInContext(extract(start, end), context);
  const draft = (text, images = [], files = []) => { input.value = text; S.images = images; S.files = files; context.autoGrow(); context.renderAttachments(); };
  return { context, input, S, calls, rows, order, notices, draft };
}
const image = { name: 'A.png', mediaType: 'image/png', data: 'AAAA' };
{
  const h = harness();
  h.context.addFileAttachment({name:'report.pdf',path:'C:\\work\\report.pdf'});
  h.context.addFileAttachment({name:'report.pdf',path:'C:/work/report.pdf'});
  assert.equal(h.S.files.length, 1);
  h.S.streaming = true;
  const pending = h.context.send();
  assert.equal(h.calls[0].method, 'steer');
  assert.equal(h.calls[0].args[0], '@"C:/work/report.pdf"');
  h.calls[0].resolve({ ok:true }); await pending;
}

// Rejected sends restore an untouched draft, but never newer text/images or a different view.
for (const scenario of ['untouched', 'new-text', 'new-image', 'edited-then-cleared', 'other-session', 'switch-back']) {
  const h = harness(); h.draft('first request', [image]);
  const pending = h.context.send();
  assert.equal(h.rows.length, 0, 'no optimistic user row');
  assert.equal(h.calls[0].args[1].images[0].mimeType, 'image/png');
  if (scenario === 'new-text') h.draft('new draft');
  if (scenario === 'new-image') h.draft('', [{ ...image, name: 'B.png' }]);
  if (scenario === 'edited-then-cleared') { h.draft('new draft'); h.draft(''); }
  if (scenario === 'other-session') { h.S.sessionSwitchSeq++; h.S.state = { ...h.S.state, sessionId: 'B' }; h.draft('B draft'); }
  if (scenario === 'switch-back') h.S.sessionSwitchSeq += 2;
  h.S.streaming = true;
  h.calls[0].resolve({ ok: false, error: 'request failed' });
  await pending;
  assert.equal(h.S.streaming, true, scenario + ': failure must not change running state');
  if (scenario === 'untouched') { assert.equal(h.input.value, 'first request'); assert.equal(h.S.images[0].name, 'A.png'); }
  if (scenario === 'new-text') assert.equal(h.input.value, 'new draft');
  if (scenario === 'other-session') assert.equal(h.input.value, 'B draft');
  if (scenario === 'new-image') { assert.equal(h.input.value, ''); assert.equal(h.S.images[0].name, 'B.png'); }
  if (scenario === 'edited-then-cleared' || scenario === 'switch-back') assert.equal(h.input.value, '');
}

{
  const h = harness(); h.draft('older request');
  const older = h.context.send();
  h.draft('newer request'); const newer = h.context.send();
  h.calls[0].reject(new Error('late failure')); await older;
  assert.equal(h.input.value, '', 'an older request cannot resurrect its draft after a newer send');
  h.calls[1].resolve({ ok: true }); await newer;
  assert.equal(h.rows.length, 0, 'accepted user events, not IPC responses, create rows');
}

// Normal and queued messages all land exactly once through the accepted event;
// repeated text is a valid new message, not a reason to suppress a user row.
{
  const h = harness();
  for (const method of ['prompt', 'steer', 'followUp']) {
    h.S.streaming = method !== 'prompt'; h.draft('same text');
    const pending = h.context.send(method);
    const call = h.calls.at(-1);
    assert.equal(call.method, method); assert.equal(h.input.value, '');
    const before = h.rows.length;
    h.context.handlePiEvent({ type: 'message_start', message: { role: 'user', content: 'same text' } }, 'A', before + 1);
    call.resolve({ ok: true }); await pending;
    assert.equal(h.rows.length, before + 1);
    assert.deepEqual(h.order.slice(h.S.streaming ? -4 : -3), h.S.streaming
      ? ['message-end', 'turn-end', 'user', 'turn-start'] : ['message-end', 'turn-end', 'user']);
  }
  assert.equal(h.rows.length, 3);
  h.S.streaming = true; h.draft('rejected queue');
  const rejected = h.context.send('followUp'); h.calls.at(-1).resolve({ ok: false, error: 'queue rejected' }); await rejected;
  assert.equal(h.input.value, 'rejected queue'); assert.equal(h.rows.length, 3);
  h.draft('image draft', [image]);
  const queuedImage = h.context.send();
  assert.equal(h.calls.length, 5, 'queued image must reach the IPC bridge');
  assert.equal(h.calls.at(-1).method, 'steer');
  assert.equal(h.calls.at(-1).args[1].images[0].mimeType, 'image/png');
  assert.equal(h.calls.at(-1).args[1].names[0], 'A.png');
  h.calls.at(-1).resolve({ ok: true }); await queuedImage;
  h.draft('', [image]);
  const followUpImage = h.context.send('followUp');
  assert.equal(h.calls.at(-1).method, 'followUp');
  assert.equal(h.calls.at(-1).args[1].images[0].data, image.data);
  h.calls.at(-1).resolve({ ok: true }); await followUpImage;
  assert.equal(h.S.images.length, 0);
}

// Expanded skills and user image blocks render the same way after snapshot restore.
// Buffered events already covered by the snapshot are discarded by its event sequence.
{
  const h = harness();
  const expanded = '<skill name="halo-imagegen" location="C:\\skills\\SKILL.md">\nReferences are relative to C:\\skills.\n\nInternal instructions\n</skill>\n\n生图';
  const message = { role: 'user', content: [{ type: 'text', text: expanded }, { type: 'image', mimeType: image.mediaType, data: image.data }] };
  h.S.switchingSession = true;
  h.context.handlePiEvent({ type: 'message_start', message }, 'A', 10);
  await h.context.restoreHistory({ state: h.S.state, seq: 10, messages: [message] });
  h.context.finishSessionSwitch();
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].text, '/skill:halo-imagegen 生图');
  assert.equal(h.rows[0].images[0].mediaType, 'image/png');
  h.context.handlePiEvent({ type: 'message_start', message }, 'A', 11);
  assert.equal(h.rows.length, 2, 'identical later user event still renders');
  h.context.handlePiEvent({ type: 'message_start', message }, 'B', 12);
  assert.equal(h.rows.length, 2, 'background session must not render');
  h.S.streaming = false;
  const retry = h.context.retryLast();
  assert.equal(h.rows.length, 2, 'retry also waits for accepted user event');
  assert.equal(h.calls[0].args[0], '/skill:halo-imagegen 生图');
  h.calls[0].resolve({ ok: false, error: 'retry failed' }); await retry;
  assert.ok(h.notices.some(text => text.includes('retry failed')));
}

// Choosing/adding a project protects the transition before the first IPC result.
{
  const h = harness(); h.draft('must stay here');
  const pending = h.context.switchProjectViaAdd('C:/other');
  assert.equal(h.S.switchingSession, true);
  h.S.lastUserPrompt = { text: 'previous prompt', images: [] };
  await h.context.retryLast();
  await h.context.send();
  assert.equal(h.calls.length, 1); assert.equal(h.input.value, 'must stay here');
  h.calls[0].resolve({ ok: false, error: 'missing directory' }); await pending;
  assert.equal(h.S.switchingSession, false);
}
for (const phase of ['project-result', 'history-result']) {
  const h = harness();
  let resets = 0, loads = 0, finishHistory;
  h.context.applyProjectReset = () => { resets++; };
  h.context.restoreHistory = () => new Promise(resolve => { finishHistory = resolve; });
  h.context.loadTree = async () => { loads++; };
  const older = h.context.switchProjectViaAdd('C:/older');
  if (phase === 'history-result') {
    h.calls[0].resolve({ ok: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resets, 1);
  }
  // A later project/session action owns the transition even if an earlier IPC
  // or history snapshot finishes afterwards.
  const newer = h.context.switchProjectViaAdd('C:/newer');
  if (phase === 'project-result') h.calls[0].resolve({ ok: true });
  else finishHistory();
  await older;
  assert.equal(resets, phase === 'history-result' ? 1 : 0);
  assert.equal(loads, 0);
  assert.equal(h.S.switchingSession, true, 'stale continuation must not finish the newer switch');
  h.calls[1].resolve({ ok: false, error: 'newer selection failed' }); await newer;
  assert.equal(h.S.switchingSession, false);
}
// Removal restores the focused view, clears a deleted server preview, and unlocks on errors.
for (const scenario of ['focused', 'preview', 'background', 'failure']) {
  const calls = [];
  const S = { sessionSwitchSeq: 0, switchingSession: false };
  const context = vm.createContext({
    S, browsingServerId: 'deleted', previewService: scenario === 'preview' ? { serverId: 'deleted' } : null,
    closeServerMenus() {},
    applyProjectReset: async () => calls.push('reset'),
    applyState: () => calls.push('state'), restoreHistory: async () => calls.push('history'),
    loadTree() {}, loadSessions() {}, loadResources() {}, loadProjects() {}, refreshServers() {},
    saveWorkspace: () => calls.push('save'), toast: () => calls.push('error'),
    finishSessionSwitch: () => { S.switchingSession = false; },
  });
  vm.runInContext(extract('async function removeWorkspaceItem(', 'async function switchProject('), context);
  await context.removeWorkspaceItem(async () => ({ ok: scenario !== 'failure', data: { switched: scenario === 'focused', state: {} } }), 'deleted');
  assert.equal(S.switchingSession, false);
  assert.equal(calls.includes('reset'), ['focused', 'preview'].includes(scenario));
  assert.equal(calls.includes('history'), ['focused', 'preview'].includes(scenario));
  assert.equal(calls.includes('error'), scenario === 'failure');
  assert.equal(context.browsingServerId, scenario === 'failure' ? 'deleted' : null);
}
console.log('PASS composer rollback isolation, accepted/queued user events, skill/image restore, retry and project/removal transition guards');

// File-only and mixed attachments must survive normal/queued sends and rejection.
for (const method of ['prompt', 'steer', 'followUp']) {
  const h = harness();
  const file = { name: '报告.pdf', path: 'C:/documents/报告.pdf', size: 100 };
  h.S.streaming = method !== 'prompt';
  h.draft('', [], [file]);
  const pending = h.context.send(method);
  assert.equal(h.calls[0].method, method);
  assert.equal(h.calls[0].args[0], '@"C:/documents/报告.pdf"');
  assert.equal(h.S.files.length, 0);
  h.calls[0].resolve({ ok: false, error: 'offline' }); await pending;
  assert.equal(h.S.files[0].path, file.path);
  h.draft('分析附件', [image], [file]);
  const mixed = h.context.send(method);
  assert.equal(h.calls[1].args[0], '分析附件\n@"C:/documents/报告.pdf"');
  assert.equal(h.calls[1].args[1].images[0].data, image.data);
  h.draft('', [], [{ ...file, name: 'new.pdf', path: 'C:/new.pdf' }]);
  h.calls[1].resolve({ ok: false, error: 'offline' }); await mixed;
  assert.equal(h.S.files[0].path, 'C:/new.pdf', 'preserve newer file draft');
}

// Native picker accepts ordinary files without reading their contents into memory.
{
  const main = fs.readFileSync('src/main/main.mjs', 'utf8');
  const start = main.indexOf('  const pickAttachments = async');
  const end = main.indexOf('  // window controls', start);
  const handlers = {}, reads = [];
  let canceled = false;
  const picker = vm.createContext({
    mainWin: null, LIMITS: { IMAGE_PICK: 25 },
    path: { basename: value => value.split('/').at(-1), extname: value => '.' + value.split('.').at(-1) },
    dialog: { showOpenDialog: async (_window, options) => {
      assert.equal(options.filters[0].extensions[0], '*');
      assert.ok(options.properties.includes('multiSelections'));
      return { canceled, filePaths: ['/报告.pdf','/table.xlsx','/photo.png','/large.jpg','/missing.txt'] };
    } },
    fs: { promises: {
      stat: async value => { if(value === '/missing.txt') throw Error('missing'); return {isFile:()=>true,size:value === '/large.jpg'?26:10}; },
      readFile: async value => { reads.push(value); return Buffer.from('image'); },
    } },
    handle: (name, handler) => { handlers[name] = handler; },
  });
  vm.runInContext(main.slice(start,end), picker);
  const result = await handlers['halo:pick-attachments']();
  assert.equal(result.files.length, 3);
  assert.equal(result.files[0].kind, 'file');
  assert.equal(result.files[0].path, '/报告.pdf');
  assert.equal(result.files[1].kind, 'file');
  assert.equal(result.files[2].mediaType, 'image/png');
  assert.deepEqual(reads, ['/photo.png']);
  assert.equal(result.skipped.join(','), 'large.jpg,missing.txt');
  canceled = true;
  assert.equal((await handlers['halo:pick-attachments']()).files.length, 0);
}
console.log('PASS file picker, mixed attachments, file-only queue and draft recovery');
