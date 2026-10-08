import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoHistory, videoHistoryLocation } from '../src/main/video-history.mjs';
import { VideoGeneration } from '../src/main/video-generation.mjs';
import { VideoSettings } from '../src/main/video-settings.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-video-history-'));
try {
  const priorProject = path.join(root, 'unregistered-prior-project');
  fs.mkdirSync(priorProject);
  const file = path.join(priorProject, 'clip.mp4');
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(40)]);
  fs.writeFileSync(file, bytes);
  const jobsFile = path.join(root, 'jobs.json');
  let jobs = [{ id: 'old', provider: 'minimax', cwd: priorProject, file, status: 'succeeded', createdAt: '2026-10-01', usage: { amount: 1, unit: 'Credits' } }];
  const requests = [];
  let fallbackCancelled = 0;
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), null, 'Playback must not send provider or renderer credentials');
    assert.equal(headers.get('cookie'), null);
    assert.equal(init.redirect, 'manual');
    assert.ok(url.startsWith('https://'));
    requests.push({ url, method: init.method, range: headers.get('range') });
    const endpoint = new URL(url).pathname;
    if (endpoint === '/network') throw Error('offline fixture');
    if (endpoint === '/gone') return new Response(null, { status: 410, headers: { 'content-length': '99', 'content-range': 'bytes 0-98/99' } });
    if (endpoint === '/missing') return new Response(null, { status: 404 });
    if (endpoint === '/forbidden') return new Response(null, { status: 403 });
    if (endpoint === '/server-error') return new Response(null, { status: 503 });
    if (endpoint === '/redirect') return new Response(null, { status: 302, headers: { location: '/clip.mp4' } });
    if (endpoint === '/insecure') return new Response(null, { status: 302, headers: { location: 'http://fixture.invalid/clip.mp4' } });
    if (endpoint === '/credentials') return new Response(null, { status: 302, headers: { location: 'https://secret:password@fixture.invalid/clip.mp4' } });
    if (endpoint === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } });
    if (endpoint === '/large') return new Response(null, { status: 200, headers: { 'content-length': String(513 * 1024 * 1024) } });
    if (endpoint === '/fallback' || endpoint === '/unsupported') {
      if (init.method === 'HEAD') return new Response(null, { status: endpoint === '/fallback' ? 405 : 501 });
      assert.equal(headers.get('range'), 'bytes=0-0');
      return new Response(new ReadableStream({ cancel() { fallbackCancelled++; } }), { status: 200 });
    }
    const responseHeaders = { 'content-type': 'video/mp4', 'content-length': String(bytes.length), 'accept-ranges': 'bytes', 'set-cookie': 'private=not-forwarded', 'x-provider-key': 'not-forwarded' };
    if (init.method === 'HEAD') return new Response(null, { headers: responseHeaders });
    if (headers.get('range') === 'bytes=4-11') return new Response(bytes.subarray(4, 12), { status: 206, headers: { ...responseHeaders, 'content-range': `bytes 4-11/${bytes.length}`, 'content-length': '8' } });
    return new Response(bytes, { headers: responseHeaders });
  };
  const history = new VideoHistory(() => jobs, { fetchImpl });
  const service = new VideoGeneration({}, jobsFile, { fetchImpl });
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  const row = service.consumptionHistory()[0];
  assert.equal(row.cwd, priorProject);
  assert.equal(row.file, file);
  assert.equal(row.exists, true);
  assert.equal(row.available, true);
  assert.equal(row.localStatus, 'ready');
  assert.equal(row.url, null, 'Old file-only records remain usable');
  assert.deepEqual(row.actual, jobs[0].usage);
  assert.equal(requests.length, 0, 'Reading history must remain offline');

  const local = await history.playback({ ...row, source: 'local', file: path.join(root, 'arbitrary.mp4'), url: 'https://untrusted.invalid' });
  assert.equal(local.status, 'ready');
  assert.equal(local.address, file, 'Ignore renderer-supplied addresses');
  assert.match(local.src, /^halo-preview:\/\/video-history\/[\da-f-]{36}$/);
  assert.ok(!local.src.includes('clip.mp4'));
  assert.equal((await history.playback({ ...row, cwd: root, source: 'local' })).status, 'unknown');
  assert.equal((await history.playback({ ...row, provider: 'apimart', source: 'local' })).status, 'unknown');
  assert.equal((await history.playback({ ...row, id: 'unrecorded', source: 'local', file })).status, 'unknown');
  assert.equal((await history.playback({ ...row, source: 'arbitrary' })).status, 'unknown');
  assert.equal((await history.playback(null)).status, 'unknown');
  const localRange = await history.response(new Request(local.src, { headers: { Range: 'bytes=4-11' } }));
  assert.equal(localRange.status, 206);
  assert.equal(await localRange.text(), 'ftypisom');
  const localHead = await history.response(new Request(local.src, { method: 'HEAD' }));
  assert.equal(localHead.headers.get('content-length'), String(bytes.length));
  assert.equal(await localHead.text(), '');
  assert.equal((await history.response(new Request(local.src, { headers: { Range: 'bytes=900-' } }))).status, 416);
  assert.equal((await history.response(new Request(local.src, { method: 'POST' }))).status, 405);
  for (const bad of [`${local.src}?file=${encodeURIComponent(file)}`, `${local.src}/../clip.mp4`, local.src.replace('video-history', 'other'), 'halo-preview://video-history/00000000-0000-0000-0000-000000000000']) {
    assert.equal((await history.response(new Request(bad))).status, 404);
  }
  jobs.push({ ...jobs[0], cwd: root, file: path.join(root, 'missing.mp4') });
  assert.equal((await history.playback({ ...row, cwd: root, source: 'local' })).status, 'deleted', 'Resolve duplicate IDs by project');
  fs.unlinkSync(file);
  const deleted = await history.playback({ ...row, source: 'local' });
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.src, null);
  assert.equal(deleted.address, file);
  assert.equal((await history.response(new Request(local.src))).status, 404, 'Old tokens must recheck the file');
  fs.writeFileSync(file, bytes);
  assert.equal((await history.playback({ ...row, source: 'local' })).status, 'ready');
  assert.equal(videoHistoryLocation({ cwd: root, file: root }).localStatus, 'unavailable');
  const nonvideo = path.join(root, 'notes.txt'); fs.writeFileSync(nonvideo, 'not a video');
  assert.equal(videoHistoryLocation({ cwd: root, file: nonvideo }).localStatus, 'unavailable');
  assert.equal(videoHistoryLocation({ cwd: root, file: nonvideo }).exists, true);
  assert.equal(videoHistoryLocation({ cwd: root, file: nonvideo }).available, false);
  assert.equal(videoHistoryLocation({ file: 'relative.mp4' }).localStatus, 'unavailable');
  assert.equal((await history.playback({ ...row, source: 'remote' })).status, 'unknown');

  const remoteJob = { id: 'cloud', provider: 'minimax', cwd: root, status: 'succeeded', url: 'https://fixture.invalid/clip.mp4', network: 'system', downloadHeaders: { Authorization: 'must-not-be-used' }, downloadAuthOrigins: ['https://fixture.invalid'] };
  jobs.push(remoteJob);
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  const beforeList = requests.length;
  assert.equal(service.consumptionHistory().find(item => item.id === 'cloud').url, remoteJob.url);
  assert.equal(requests.length, beforeList);
  const remote = await history.playback({ ...remoteJob, source: 'remote', url: 'https://untrusted.invalid' });
  assert.equal(remote.status, 'ready');
  assert.equal(remote.address, remoteJob.url);
  assert.match(remote.src, /^halo-preview:\/\/video-history\//);
  assert.equal(requests.at(-1).method, 'HEAD');
  const remoteRange = await history.response(new Request(remote.src, { headers: { Range: 'bytes=4-11', Authorization: 'incoming-private-key', Cookie: 'incoming-private-cookie' } }));
  assert.equal(remoteRange.status, 206);
  assert.equal(remoteRange.headers.get('content-range'), `bytes 4-11/${bytes.length}`);
  assert.equal(remoteRange.headers.get('set-cookie'), null);
  assert.equal(remoteRange.headers.get('x-provider-key'), null);
  assert.equal(await remoteRange.text(), 'ftypisom');
  const remoteHead = await history.response(new Request(remote.src, { method: 'HEAD' }));
  assert.equal(remoteHead.headers.get('content-length'), String(bytes.length));
  assert.equal(await remoteHead.text(), '');
  const beforeBadRange = requests.length;
  assert.equal((await history.response(new Request(remote.src, { headers: { Range: 'bytes=0-1,9-10' } }))).status, 416);
  assert.equal(requests.length, beforeBadRange);

  for (const [endpoint, expected] of [['gone', 'expired'], ['missing', 'expired'], ['forbidden', 'unavailable'], ['network', 'unavailable'], ['server-error', 'unavailable'], ['large', 'unavailable'], ['insecure', 'unavailable'], ['credentials', 'unavailable'], ['loop', 'unavailable'], ['redirect', 'ready'], ['fallback', 'ready'], ['unsupported', 'ready']]) {
    remoteJob.url = `https://fixture.invalid/${endpoint}`;
    const checked = await history.playback({ ...remoteJob, source: 'remote' });
    assert.equal(checked.status, expected, endpoint);
    assert.equal(checked.src === null, expected !== 'ready', endpoint);
  }
  assert.equal(fallbackCancelled, 2, 'Cancel ignored Range bodies without downloading them');
  assert.equal(requests.filter(item => new URL(item.url).pathname === '/loop').length, 6, 'Bound redirects');
  for (const invalid of ['http://fixture.invalid/clip.mp4', 'https://user:password@fixture.invalid/clip.mp4', 'not a URL']) {
    remoteJob.url = invalid;
    const before = requests.length;
    assert.equal((await history.playback({ ...remoteJob, source: 'remote' })).status, 'unavailable');
    assert.equal(requests.length, before);
  }
  remoteJob.url = 'https://fixture.invalid/gone';
  const goneResponse = await history.response(new Request(remote.src));
  assert.equal(goneResponse.status, 410, 'Old token must recheck the recorded URL');
  assert.equal(goneResponse.headers.get('content-length'), null, 'Empty errors must not advertise an upstream body');
  assert.equal(goneResponse.headers.get('content-range'), null);
  remoteJob.url = 'https://fixture.invalid/clip.mp4';
  jobs = jobs.filter(item => item !== remoteJob);
  assert.equal((await history.response(new Request(remote.src))).status, 404, 'Removing a record revokes its token');

  let streamCancelled = 0;
  const limited = new VideoHistory(() => [remoteJob], { maxBytes: 8, fetchImpl: async (_url, init) => init.method === 'HEAD'
    ? new Response(null)
    : new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel() { streamCancelled++; } })) });
  const limitedToken = (await limited.playback({ ...remoteJob, source: 'remote' })).src;
  const oversized = await limited.response(new Request(limitedToken));
  await assert.rejects(oversized.arrayBuffer(), /超过/);
  assert.equal(streamCancelled, 1, 'Unknown-length media is counted while streaming and cancelled at the limit');
  const cancelled = await limited.response(new Request(limitedToken));
  await cancelled.body.cancel();
  assert.equal(streamCancelled, 2, 'Stopping playback releases the upstream stream');
  const controller = new AbortController();
  const interrupted = await limited.response(new Request(limitedToken, { signal: controller.signal }));
  controller.abort();
  await assert.rejects(interrupted.arrayBuffer(), /abort/i);
  assert.equal(streamCancelled, 3, 'Aborting the media request releases the upstream stream');

  const settings = new VideoSettings(path.join(root, 'settings.json'), { seal: value => value, unseal: value => value });
  settings.save({ provider: 'minimax', apiKey: 'offline-fixture-key' });
  let returnedURL = 'https://fixture.invalid/initial.mp4', failDownload = true, creates = 0;
  const generation = new VideoGeneration(settings, path.join(root, 'new-jobs.json'), { confirmGeneration: async () => true,
    providers: { minimax: { create: async () => { creates++; return 'new'; }, query: async () => ({ status: 'succeeded', url: returnedURL }) } },
    fetchImpl: async () => failDownload ? new Response(null, { status: 503 }) : new Response(bytes),
  });
  const failedDownload = await generation.run('new-call', { action: 'generate', prompt: 'fixture' }, root);
  assert.match(failedDownload.error, /下载失败/);
  assert.equal(generation.jobs()[0].url, returnedURL, 'Store cloud URL before download, including failed downloads');
  assert.equal(generation.consumptionHistory()[0].url, returnedURL);
  failDownload = false;
  const recovered = await generation.run('status-call', { action: 'status', task_id: 'new' }, root);
  assert.ok(recovered.file);
  returnedURL = 'https://fixture.invalid/renewed.mp4';
  await generation.run('settled-call', { action: 'status', task_id: 'new' }, root);
  assert.equal(generation.jobs()[0].url, returnedURL, 'Explicit status can refresh the cloud URL without another download');
  assert.equal(creates, 1);
  assert.equal(generation.consumptionHistory()[0].localStatus, 'ready');
  console.log('PASS offline history, old and foreign-project files, record-scoped authorization, deleted files, local/cloud ranges, credential isolation, bounded probes, HTTPS redirects and URL persistence before download');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('halo-video-history-'));
  fs.rmSync(root, { recursive: true, force: true });
}
