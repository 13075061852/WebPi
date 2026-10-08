import { createVoiceRecorder } from './voice-recorder.mjs';
import { VOICE_SAMPLE_GUIDE, encodeVoiceWav, analyzeVoiceSample, estimateSpeechSeconds, planSpeechSegments } from './voice-sample.mjs';

export function initDigitalHuman({ root = document, api = window.halo, open, configure } = {}) {
  const get = id => root.querySelector(`#${id}`);
  const forms = { profile: get('digitalHumanProfileForm'), draft: get('digitalHumanForm') };
  const doc = forms.draft.ownerDocument;
  const sequences = { profile: 0, draft: 0 }, dirty = { profile: false, draft: false }, timers = {};
  let state, busy = 0, mutation, selectedPhotos = [], recordingState = 'idle';
  const profile = () => ({ photoId: selectedPhotos[0] || null, photoIds: [...selectedPhotos], voiceId: get('digitalHumanVoice').value || null });
  const draft = () => ({ script: get('digitalHumanScript').value, scene: get('digitalHumanScene').value,
    action: get('digitalHumanAction').value, resolution: get('digitalHumanResolution').value, ratio: get('digitalHumanRatio').value });
  const hint = kind => kind === 'profile' ? '照片与声音保存在本机' : '本次视频草稿保存在本机';
  function feedback(kind, text, error = false) {
    clearTimeout(timers[kind]);
    const status = get(kind === 'profile' ? 'digitalHumanStatus' : 'digitalHumanDraftStatus');
    status.textContent = text;
    status.classList.toggle('error', error);
  }
  function controls() {
    for (const form of Object.values(forms)) form.querySelectorAll('textarea, select, button').forEach(control => { control.disabled = busy > 0 || recordingState !== 'idle'; });
    get('digitalHumanGenerate').disabled = true;
    get('digitalHumanRecordStop').disabled = recordingState !== 'recording';
    get('digitalHumanRecordCancel').disabled = !['recording', 'requesting'].includes(recordingState);
  }
  const assetFor = (kind, id) => state?.[kind === 'photo' ? 'photos' : 'voices'].find(asset => asset.id === id);
  const current = kind => assetFor(kind, kind === 'photo' ? selectedPhotos[0] : get('digitalHumanVoice').value);
  function photoPreview() {
    get('digitalHumanPhotoGallery').replaceChildren(...(state?.photos || []).map(asset => {
      const tile = doc.createElement('div'); tile.className = 'digital-human-photo-tile';
      const select = doc.createElement('button'); select.type = 'button'; select.dataset.photoId = asset.id;
      select.setAttribute('aria-pressed', String(selectedPhotos.includes(asset.id))); select.title = asset.name;
      select.setAttribute('aria-label', `选择照片 ${asset.name}`);
      const image = doc.createElement('img'); image.src = asset.previewURL; image.alt = asset.name;
      image.addEventListener('error', () => { image.hidden = true; select.textContent = '照片无法读取'; });
      const mark = doc.createElement('span'); mark.textContent = selectedPhotos.includes(asset.id) ? '✓' : '';
      select.append(image, mark);
      const remove = doc.createElement('button'); remove.type = 'button'; remove.dataset.photoRemove = asset.id;
      remove.className = 'digital-human-photo-remove'; remove.textContent = '×'; remove.title = '移除照片'; remove.setAttribute('aria-label', `移除照片 ${asset.name}`);
      tile.append(select, remove); return tile;
    }));
    get('digitalHumanPhotoPlaceholder').hidden = !!state?.photos.length;
    get('digitalHumanPhotoCount').textContent = `${selectedPhotos.length} / 9`;
  }
  function stopAudio() {
    const audio = get('digitalHumanVoicePreview');
    audio.pause(); audio.removeAttribute('src'); audio.load();
  }
  function voicePreview() {
    const asset = current('voice'), player = get('digitalHumanVoicePreview');
    stopAudio();
    player.hidden = !asset?.available;
    if (asset?.available) player.src = asset.previewURL;
    get('digitalHumanVoiceDelete').hidden = !asset;
    get('digitalHumanVoiceInfo').textContent = asset ? `${asset.name} · ${Number.isFinite(asset.duration) ? `${asset.duration.toFixed(1)} 秒` : '待校验'} · ${{ 'audio/mpeg': 'MP3', 'audio/mp4': 'M4A', 'audio/wav': 'WAV' }[asset.mime] || '录音'}` : '建议录制 30–60 秒 · MP3 / M4A / WAV';
    get('digitalHumanVoiceQuality').textContent = asset ? asset.quality === 'ready' && asset.available ? '已完成本地音频校验 · 尚未克隆音色' : asset.exists === false ? '录音已删除，请重新导入' : '录音未完成校验，请重新导入' : '';
  }
  function configuredPreview() {
    const photo = assetFor('photo', state?.profile.photoId), voice = assetFor('voice', state?.profile.voiceId);
    const image = get('digitalHumanConfiguredPhoto');
    image.hidden = !photo?.available;
    if (photo?.available) { image.src = photo.previewURL; image.alt = photo.name; }
    else image.removeAttribute('src');
    get('digitalHumanConfiguredName').textContent = photo?.available ? `${state.profile.photoIds?.length || 1} 张参考照片` : photo ? '人物照片已删除，请重新配置' : '未配置人物照片';
    get('digitalHumanConfiguredVoice').textContent = voice?.available ? `声音 · ${voice.name}` : voice ? '声音不可用，请重新配置' : '未配置声音';
    get('digitalHumanConfigure').textContent = photo?.available && voice?.available ? '修改配置' : '配置数字人';
  }
  function speechPlan() {
    const script = get('digitalHumanScript').value;
    const seconds = estimateSpeechSeconds(script), segments = planSpeechSegments(script);
    get('digitalHumanDuration').textContent = seconds ? `约 ${Math.ceil(seconds)} 秒` : '';
    get('digitalHumanSegments').hidden = segments.length < 2;
    get('digitalHumanSegmentSummary').textContent = `建议分成 ${segments.length} 段 · 单段不超过约 15 秒`;
    get('digitalHumanSegmentList').replaceChildren(...segments.map(text => {
      const item = doc.createElement('li'); item.textContent = text; return item;
    }));
  }
  function renderProfile(value, values = value.profile) {
    state = value;
    selectedPhotos = [...(values?.photoIds || (values?.photoId ? [values.photoId] : []))];
    const select = get('digitalHumanVoice'), blank = doc.createElement('option');
    blank.value = ''; blank.textContent = '选择声音样本';
    select.replaceChildren(blank, ...value.voices.map(asset => {
      const option = doc.createElement('option'); option.value = asset.id;
      option.textContent = asset.name + (asset.exists === false ? ' · 已删除' : ''); return option;
    }));
    select.value = values?.voiceId || '';
    photoPreview(); voicePreview(); configuredPreview();
    get('digitalHumanProfileLoading').hidden = true;
    get('digitalHumanProfileFields').hidden = false;
  }
  function renderDraft(value, values = value.draft) {
    state = value;
    for (const [field, id] of [['script', 'digitalHumanScript'], ['scene', 'digitalHumanScene'], ['action', 'digitalHumanAction'], ['resolution', 'digitalHumanResolution'], ['ratio', 'digitalHumanRatio']]) {
      get(id).value = values?.[field] ?? (field === 'resolution' ? '768P' : field === 'ratio' ? '16:9' : '');
    }
    configuredPreview(); speechPlan();
    get('digitalHumanLoading').hidden = true;
    get('digitalHumanFields').hidden = false;
  }
  async function checked(reply) {
    const result = await reply;
    if (!result?.ok) throw Error(result?.error || '操作失败，请重试');
    return result.data;
  }
  async function importAsset(kind) {
    if (busy) return;
    busy++; controls();
    const request = sequences.profile;
    let asset;
    try {
      feedback('profile', kind === 'photo' ? '正在导入照片…' : '正在导入录音…');
      asset = await checked(api.digitalHumanImport(kind));
      if (!asset) { if (request === sequences.profile) feedback('profile', hint('profile')); return; }
      let quality;
      if (kind === 'voice') {
        if (request === sequences.profile) feedback('profile', '正在检查录音…');
        const bytes = Uint8Array.from(atob(asset.data), character => character.charCodeAt(0));
        const context = new AudioContext({ sampleRate: 24000 });
        try { quality = analyzeVoiceSample(await context.decodeAudioData(bytes.buffer)); }
        catch (error) {
          await checked(api.digitalHumanAssetDelete(asset.id));
          throw Error(error?.name === 'EncodingError' ? '录音无法解码，请选择有效的 MP3、M4A 或 WAV' : error.message);
        } finally { await context.close(); }
        await checked(api.digitalHumanAssetUpdate({ id: asset.id, duration: quality.duration, quality: 'ready' }));
      }
      const result = await checked(api.digitalHumanState());
      if (request !== sequences.profile) return;
      const values = kind === 'photo' ? { ...profile(), photoIds: [...new Set([...selectedPhotos, ...asset.assets.map(item => item.id)])].slice(0, 9) } : { ...profile(), voiceId: asset.id };
      dirty.profile = true; renderProfile(result, values);
      if (quality?.warnings.length) get('digitalHumanVoiceQuality').textContent += ` · ${quality.warnings.join('；')}`;
      if (asset.errors?.length) { feedback('profile', asset.errors.join('；'), true); return; }
      feedback('profile', quality?.warnings.length ? '请试听录音，确认后保存配置' : '保存配置后用于生成视频');
    } catch (error) {
      if (request === sequences.profile) feedback('profile', error.message || '导入失败，请重试', true);
    } finally { busy--; controls(); }
  }
  async function remove(kind, id) {
    const asset = id ? assetFor(kind, id) : current(kind);
    if (!asset || busy) return;
    busy++; controls();
    const request = sequences.profile, values = kind === 'photo' ? { ...profile(), photoIds: selectedPhotos.filter(id => id !== asset.id) } : { ...profile(), voiceId: null };
    if (kind === 'voice') stopAudio();
    try {
      const result = await checked(api.digitalHumanAssetDelete(asset.id));
      if (request !== sequences.profile) return;
      dirty.profile = true; renderProfile(result, values); feedback('profile', hint('profile'));
    } catch (error) { if (request === sequences.profile) feedback('profile', error.message, true); }
    finally { busy--; controls(); }
  }
  function mutate(action) {
    const pending = action(); mutation = pending;
    void pending.finally(() => { if (mutation === pending) mutation = null; });
  }
  async function save(kind) {
    if (busy || recordingState !== 'idle' || !state) return;
    busy++; controls();
    const request = sequences[kind], values = kind === 'profile' ? profile() : draft();
    try {
      const result = await checked(kind === 'profile' ? api.digitalHumanProfileSave(values) : api.digitalHumanDraftSave(values));
      dirty[kind] = false; state = result;
      if (request !== sequences[kind]) return;
      configuredPreview(); feedback(kind, kind === 'profile' ? '配置已保存' : '草稿已保存');
      timers[kind] = setTimeout(() => feedback(kind, hint(kind)), 1800);
    } catch (error) { if (request === sequences[kind]) feedback(kind, error.message, true); }
    finally { busy--; controls(); }
  }
  async function load(kind) {
    const request = ++sequences[kind], values = state && dirty[kind] ? (kind === 'profile' ? profile() : draft()) : null;
    busy++; controls(); feedback(kind, hint(kind));
    const loading = get(kind === 'profile' ? 'digitalHumanProfileLoading' : 'digitalHumanLoading');
    if (!state) { loading.textContent = '正在读取…'; loading.hidden = false; get(kind === 'profile' ? 'digitalHumanProfileFields' : 'digitalHumanFields').hidden = true; }
    try {
      await mutation;
      const value = await checked(api.digitalHumanState());
      if (request !== sequences[kind]) return;
      if (kind === 'profile') renderProfile(value, values || value.profile);
      else renderDraft(value, values || value.draft);
    } catch (error) {
      if (request === sequences[kind]) { loading.textContent = '读取失败，请重试'; feedback(kind, error.message, true); }
    } finally { busy--; controls(); }
  }
  get('digitalHumanReadingText').textContent = VOICE_SAMPLE_GUIDE.readingText.replace(/\n\n/g, '\n');
  for (const [id, action] of [['digitalHumanPhotoImport', () => importAsset('photo')], ['digitalHumanVoiceImport', () => importAsset('voice')], ['digitalHumanVoiceDelete', () => remove('voice')]]) {
    get(id).addEventListener('click', () => mutate(action));
  }
  get('digitalHumanPhotoGallery').addEventListener('click', event => {
    if (busy || recordingState !== 'idle') return;
    const removeButton = event.target.closest('[data-photo-remove]');
    if (removeButton) { mutate(() => remove('photo', removeButton.dataset.photoRemove)); return; }
    const button = event.target.closest('[data-photo-id]'); if (!button) return;
    const id = button.dataset.photoId;
    if (selectedPhotos.includes(id)) selectedPhotos = selectedPhotos.filter(value => value !== id);
    else if (selectedPhotos.length < 9) selectedPhotos.push(id);
    else { feedback('profile', '最多选择 9 张参考照片', true); return; }
    dirty.profile = true; photoPreview(); feedback('profile', '保存配置后用于生成视频');
  });
  get('digitalHumanVoice').addEventListener('change', () => { dirty.profile = true; voicePreview(); feedback('profile', '保存配置后用于生成视频'); });
  const recorder = createVoiceRecorder({
    onState(value, seconds) {
      recordingState = value;
      get('digitalHumanRecorder').hidden = value === 'idle';
      get('digitalHumanRecorder').dataset.state = value;
      get('digitalHumanRecordTime').textContent = value === 'recording' ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : value === 'requesting' ? '正在连接麦克风…' : '正在处理录音…';
      controls();
    },
    onError(message) { feedback('profile', message, true); },
    async onComplete(blob) {
      const request = sequences.profile, context = new AudioContext({ sampleRate: 24000 });
      let asset;
      try {
        const buffer = await context.decodeAudioData(await blob.arrayBuffer());
        const quality = analyzeVoiceSample(buffer);
        if (request !== sequences.profile) return;
        asset = await checked(api.digitalHumanRecording(encodeVoiceWav(buffer)));
        await checked(api.digitalHumanAssetUpdate({ id: asset.id, duration: quality.duration, quality: 'ready' }));
        const result = await checked(api.digitalHumanState());
        if (request !== sequences.profile) return;
        dirty.profile = true; renderProfile(result, { ...profile(), voiceId: asset.id });
        if (quality.warnings.length) get('digitalHumanVoiceQuality').textContent += ` · ${quality.warnings.join('；')}`;
        feedback('profile', '录音已保存，试听后保存配置');
      } catch (error) {
        if (asset) await checked(api.digitalHumanAssetDelete(asset.id));
        throw error;
      } finally { await context.close(); }
    },
  });
  get('digitalHumanRecordStart').addEventListener('click', () => { if (!busy) { stopAudio(); void recorder.start(); } });
  get('digitalHumanRecordStop').addEventListener('click', () => recorder.stop());
  get('digitalHumanRecordCancel').addEventListener('click', () => recorder.cancel());
  window.addEventListener('beforeunload', () => recorder.cancel());
  get('digitalHumanVoicePreview').addEventListener('error', () => { if (get('digitalHumanVoicePreview').hasAttribute('src')) feedback('profile', '录音无法播放，请重新导入', true); });
  get('digitalHumanConfiguredPhoto').addEventListener('error', () => { get('digitalHumanConfiguredPhoto').hidden = true; get('digitalHumanConfiguredName').textContent = '人物照片无法读取，请重新配置'; });
  get('digitalHumanConfigure').addEventListener('click', () => configure?.());
  forms.draft.addEventListener('input', () => { dirty.draft = true; speechPlan(); });
  for (const kind of ['profile', 'draft']) forms[kind].addEventListener('submit', event => { event.preventDefault(); mutate(() => save(kind)); });
  return {
    open() { open(); return load('draft'); },
    openProfile() { return load('profile'); },
    close() { sequences.draft++; clearTimeout(timers.draft); },
    closeProfile() { sequences.profile++; clearTimeout(timers.profile); recorder.cancel(); stopAudio(); },
  };
}
