const playbackMessages = {
  deleted: '本地视频已删除',
  expired: '视频链接已失效或被删除',
  unavailable: '视频暂时无法访问，请稍后重试',
  unknown: '该记录未保存视频地址',
};

export function initVideoHistory({ body, api, open } = {}) {
  const doc = body.ownerDocument;
  let listRequest = 0, playbackRequest = 0, active = null, pending = null;
  const node = (tag, className, text) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function removePlayer() {
    if (!active) return;
    clearTimeout(active.timer);
    active.video.pause();
    active.video.removeAttribute('src');
    active.video.load();
    active.video.remove();
    active.notice.textContent = '';
    active = null;
  }
  function stopPlayback() {
    playbackRequest++;
    removePlayer();
    if (pending) {
      pending.buttons.forEach(button => { button.disabled = false; });
      pending.notice.textContent = '';
      pending = null;
    }
  }
  function sourceState(sourceRow, status) {
    const label = sourceRow.querySelector('.video-history-source-status');
    label.textContent = status === 'deleted' ? playbackMessages.deleted : status === 'expired' ? playbackMessages.expired : '';
    sourceRow.querySelectorAll('button').forEach(button => { button.disabled = status === 'deleted' || status === 'expired'; });
  }
  async function play(job, source, sourceRow, record, notice) {
    stopPlayback();
    const sequence = playbackRequest;
    const buttons = [...sourceRow.querySelectorAll('button')];
    pending = { buttons, notice };
    buttons.forEach(button => { button.disabled = true; });
    notice.textContent = '正在检查视频…';
    const identity = { id: job.id, provider: job.provider, cwd: job.cwd, source };
    try {
      const reply = await api.videoHistoryPlayback(identity);
      if (sequence !== playbackRequest) return;
      buttons.forEach(button => { button.disabled = false; });
      pending = null;
      if (!reply?.ok) throw Error('无法读取视频');
      const result = reply.data;
      sourceState(sourceRow, result?.status);
      if (result?.status !== 'ready' || !result.src) {
        notice.textContent = playbackMessages[result?.status] || playbackMessages.unavailable;
        return;
      }
      const video = node('video', 'video-history-player');
      video.controls = true;
      video.preload = 'auto';
      video.setAttribute('aria-label', `${job.providerName} · ${job.model} 视频`);
      let checkingError = false;
      const failed = async () => {
        if (sequence !== playbackRequest || active?.video !== video || checkingError) return;
        checkingError = true;
        removePlayer();
        pending = { buttons, notice };
        buttons.forEach(button => { button.disabled = true; });
        notice.textContent = '正在检查视频…';
        try {
          const check = await api.videoHistoryPlayback(identity);
          if (sequence !== playbackRequest) return;
          pending = null;
          buttons.forEach(button => { button.disabled = false; });
          const status = check?.ok ? check.data?.status : 'unavailable';
          sourceState(sourceRow, status);
          notice.textContent = status === 'ready' ? '视频无法播放，请重试' : playbackMessages[status] || playbackMessages.unavailable;
        } catch {
          if (sequence === playbackRequest) {
            pending = null;
            buttons.forEach(button => { button.disabled = false; });
            notice.textContent = playbackMessages.unavailable;
          }
        }
      };
      video.addEventListener('error', failed, { once: true });
      video.addEventListener('loadeddata', () => {
        if (sequence !== playbackRequest || active?.video !== video) return;
        clearTimeout(active.timer);
        notice.textContent = '';
      }, { once: true });
      active = { video, notice, timer: setTimeout(failed, 20000) };
      notice.textContent = '正在加载视频…';
      video.src = result.src;
      record.append(video);
      video.scrollIntoView({ block: 'nearest' });
      // Native controls remain usable if the platform requires another gesture.
      video.play().catch(() => {});
    } catch {
      if (sequence !== playbackRequest) return;
      buttons.forEach(button => { button.disabled = false; });
      pending = null;
      notice.textContent = playbackMessages.unavailable;
    }
  }
  function renderRecord(job) {
    const record = node('div', 'video-history-record');
    record.dataset.jobId = job.id;
    const summary = node('div', 'usage-session-row video-history-summary');
    summary.title = `任务 ${job.id}`;
    const main = node('div');
    main.append(node('b', '', `${job.providerName} · ${job.model}`),
      node('small', '', `${job.createdAt ? new Date(job.createdAt).toLocaleString() : ''} · ${job.resolution || '—'} · ${job.duration || '—'} 秒`));
    const numbers = node('div', 'usage-session-numbers');
    const actual = Number.isFinite(job.actual?.amount), value = actual ? job.actual.amount : job.estimate?.total;
    const unit = actual ? job.actual.unit : job.estimate?.currency;
    let amount = Number.isFinite(value) ? `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)} ${unit === 'Credits' ? '积分' : unit || ''}` : '消耗未返回';
    if (!actual && Number.isFinite(value)) amount = '预估 ' + amount;
    const status = ({ delivered: '已完成', succeeded: '生成成功', failed: '失败', queued: '排队中', processing: '生成中' })[job.status] || job.status || '未知状态';
    numbers.append(node('strong', '', amount), node('small', '', `${status} · ${actual ? '实际消耗' : '暂无实际消耗'}`));
    summary.append(main, numbers);
    record.append(summary);
    const notice = node('div', 'video-history-notice');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    for (const [source, address] of [['local', job.file], ['remote', job.url]]) {
      if (!address) continue;
      const sourceRow = node('div', 'video-history-source');
      sourceRow.dataset.source = source;
      const label = node('span', 'video-history-source-label', source === 'local' ? '本地' : '云端');
      const link = node('button', 'video-history-address', address);
      link.type = 'button';
      link.title = address;
      link.setAttribute('aria-label', `播放${source === 'local' ? '本地' : '云端'}视频：${address}`);
      const button = node('button', 'mini-btn video-history-play', '播放');
      button.type = 'button';
      button.setAttribute('aria-label', `播放${source === 'local' ? '本地' : '云端'}视频`);
      const sourceStatus = node('span', 'video-history-source-status');
      sourceRow.append(label, link, button, sourceStatus);
      for (const control of [link, button]) control.addEventListener('click', () => play(job, source, sourceRow, record, notice));
      if (source === 'local') sourceState(sourceRow, job.localStatus);
      record.append(sourceRow);
    }
    if (!job.file && !job.url) notice.textContent = playbackMessages.unknown;
    record.append(notice);
    return record;
  }
  return {
    async open() {
      open();
      stopPlayback();
      const sequence = ++listRequest;
      body.replaceChildren(node('div', 'model-empty', '正在读取记录…'));
      try {
        const reply = await api.videoHistory();
        if (sequence !== listRequest) return;
        if (!reply?.ok || !Array.isArray(reply.data)) throw Error('读取失败');
        body.replaceChildren(...(reply.data.length ? reply.data.map(renderRecord) : [node('div', 'model-empty', '暂无视频生成记录')]));
      } catch {
        if (sequence === listRequest) body.replaceChildren(node('div', 'model-empty', '读取失败，请点击刷新重试'));
      }
    },
    close() {
      listRequest++;
      stopPlayback();
    },
  };
}
