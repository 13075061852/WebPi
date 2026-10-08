import assert from 'node:assert/strict';
import { initVideoHistory } from '../src/renderer/js/video-history.mjs';

// Only the DOM/media surface used by this controller is simulated. No Electron,
// network, generated media, user profiles or billing accounts are accessed.
function createDocument() {
  const media = [];
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = document;
      this.children = [];
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.textContent = '';
      this.className = '';
      this.disabled = false;
      this.playCount = 0;
      this.pauseCount = 0;
      this.loadCount = 0;
      this.src = '';
    }
    append(...children) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      this.children.forEach(child => { child.parentNode = null; });
      this.children = [];
      this.append(...children);
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === 'src') this.src = '';
    }
    addEventListener(name, listener, options = {}) { this.listeners.set(name, { listener, once: options.once }); }
    dispatch(name) {
      const handler = this.listeners.get(name);
      if (!handler) return undefined;
      if (handler.once) this.listeners.delete(name);
      return handler.listener({ type: name, target: this });
    }
    querySelectorAll(selector) {
      const matches = [];
      const visit = element => {
        const match = selector.startsWith('.') ? element.className.split(' ').includes(selector.slice(1)) : element.tagName.toLowerCase() === selector;
        if (match) matches.push(element);
        element.children.forEach(visit);
      };
      this.children.forEach(visit);
      return matches;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    scrollIntoView() {}
    play() { this.playCount++; return Promise.resolve(); }
    pause() { this.pauseCount++; }
    load() { this.loadCount++; }
  }
  const document = { media, createElement: tag => {
    const element = new Element(tag);
    if (tag === 'video') media.push(element);
    return element;
  } };
  return document;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const jobs = ['A', 'B'].map(id => ({
  id, provider: 'fixture', providerName: 'Offline fixture', model: 'Test', status: 'delivered',
  cwd: 'C:/isolated-video-history-fixture', file: `C:/isolated-video-history-fixture/${id}.mp4`,
  url: `https://video.invalid/${id}.mp4`, actual: { amount: 12.5, unit: 'Credits' },
}));
const ready = src => ({ ok: true, data: { status: 'ready', src } });
function fixture(playback, history = async () => ({ ok: true, data: jobs })) {
  const document = createDocument(), body = document.createElement('div'), calls = [];
  const controller = initVideoHistory({ body, open() {}, api: {
    videoHistory: history,
    videoHistoryPlayback: input => { calls.push(input); return playback(input, calls.length); },
  } });
  return { document, body, controller, calls };
}
const records = body => body.querySelectorAll('.video-history-record');
const row = (record, source = 'local') => record.querySelectorAll('.video-history-source').find(element => element.dataset.source === source);
const notice = record => record.querySelector('.video-history-notice');
function click(element) {
  assert.equal(element.disabled, false, 'Only an enabled address or Play button can be clicked');
  return element.dispatch('click');
}

// Closing during the history request must not repaint records after close.
{
  const response = deferred();
  const test = fixture(() => ready('halo-video:unused'), () => response.promise);
  const opening = test.controller.open();
  test.controller.close();
  response.resolve({ ok: true, data: jobs });
  await opening;
  assert.equal(records(test.body).length, 0);
  assert.equal(test.document.media.length, 0);
}

// A late first playback reply must never start a hidden player after close.
{
  const response = deferred(), test = fixture(() => response.promise);
  try {
    await test.controller.open();
    const record = records(test.body)[0], source = row(record);
    const playing = click(source.querySelector('.video-history-play'));
    assert.equal(source.querySelector('.video-history-play').disabled, true);
    test.controller.close();
    assert.equal(notice(record).textContent, '');
    response.resolve(ready('halo-video:closed'));
    await playing;
    assert.equal(test.document.media.length, 0, 'Closed requests cannot even create a video element');
    assert.equal(test.body.querySelector('video'), null);
    assert.equal(source.querySelector('.video-history-play').disabled, false);
  } finally { test.controller.close(); }
}

// Refresh invalidates an old playback request; its later reply cannot replace
// a player opened from the newly rendered records.
{
  const response = deferred(), test = fixture((_input, count) => count === 1 ? response.promise : ready('halo-video:refreshed'));
  try {
    await test.controller.open();
    const oldRecord = records(test.body)[0];
    const oldPlayback = click(row(oldRecord).querySelector('.video-history-address'));
    await test.controller.open();
    assert.equal(notice(oldRecord).textContent, '');
    const newRecord = records(test.body)[1];
    await click(row(newRecord).querySelector('.video-history-play'));
    const player = newRecord.querySelector('video');
    response.resolve(ready('halo-video:stale'));
    await oldPlayback;
    assert.equal(test.document.media.length, 1);
    assert.equal(test.body.querySelector('video'), player);
    assert.equal(player.src, 'halo-video:refreshed');
  } finally { test.controller.close(); }
}

// Switching local/cloud addresses within one record keeps only the latest
// source, even when the previous source's response arrives last.
{
  const response = deferred(), test = fixture((_input, count) => count === 1 ? response.promise : ready('halo-video:cloud'));
  try {
    await test.controller.open();
    const record = records(test.body)[0];
    const localPlayback = click(row(record).querySelector('.video-history-address'));
    await click(row(record, 'remote').querySelector('.video-history-address'));
    const player = record.querySelector('video');
    response.resolve(ready('halo-video:late-local'));
    await localPlayback;
    assert.deepEqual(test.calls.map(call => call.source), ['local', 'remote']);
    assert.equal(test.document.media.length, 1);
    assert.equal(record.querySelector('video'), player);
    assert.equal(player.controls, true);
    assert.equal(player.playCount, 1);
    assert.equal(player.src, 'halo-video:cloud');
  } finally { test.controller.close(); }
}

// A decoder error triggers a slow existence check. Switching records during
// that check must clear its loading notice and ignore its eventual result.
{
  const response = deferred(), test = fixture((input, count) => count === 2 ? response.promise : ready(`halo-video:${input.id}`));
  try {
    await test.controller.open();
    const [recordA, recordB] = records(test.body), sourceA = row(recordA);
    await click(sourceA.querySelector('.video-history-play'));
    const oldPlayer = recordA.querySelector('video');
    oldPlayer.error = { code: 3 };
    const checking = oldPlayer.dispatch('error');
    assert.equal(notice(recordA).textContent, '正在检查视频…');
    assert.equal(sourceA.querySelector('.video-history-play').disabled, true);
    await click(row(recordB).querySelector('.video-history-play'));
    const playerB = recordB.querySelector('video');
    assert.equal(notice(recordA).textContent, '', 'Switching must clear an abandoned error-check notice');
    response.resolve({ ok: true, data: { status: 'deleted' } });
    await checking;
    assert.equal(test.body.querySelector('video'), playerB);
    assert.equal(playerB.src, 'halo-video:B');
    assert.equal(sourceA.querySelector('.video-history-source-status').textContent, '', 'A stale check cannot mark the old source deleted');
    assert.equal(sourceA.querySelector('.video-history-play').disabled, false);
    assert.equal(oldPlayer.src, '');
    assert.equal(oldPlayer.parentNode, null);
    assert.ok(oldPlayer.pauseCount > 0);
  } finally { test.controller.close(); }
}

// Existing-but-undecodable media is retryable. It is not labeled as deleted,
// and the historical charge remains visible regardless of playback failure.
{
  const test = fixture(() => ready('halo-video:unsupported-codec'));
  try {
    await test.controller.open();
    const record = records(test.body)[0], source = row(record);
    const cost = record.querySelector('strong').textContent;
    await click(source.querySelector('.video-history-play'));
    const player = record.querySelector('video');
    player.dispatch('loadeddata');
    player.error = { code: 3 };
    await player.dispatch('error');
    assert.equal(test.calls.length, 2, 'Media errors recheck the underlying address before classifying it');
    assert.equal(notice(record).textContent, '视频无法播放，请重试');
    assert.equal(source.querySelector('.video-history-source-status').textContent, '');
    assert.equal(source.querySelector('.video-history-play').disabled, false);
    assert.equal(record.querySelector('strong').textContent, cost);
    assert.equal(cost, '12.5 积分');
    await click(source.querySelector('.video-history-play'));
    assert.equal(record.querySelector('video').playCount, 1, 'A decoder error retains a usable retry action');
  } finally { test.controller.close(); }
}

console.log('PASS video history UI: close/refresh/switch races, stale error checks, clickable addresses, decoder retry and retained cost');
