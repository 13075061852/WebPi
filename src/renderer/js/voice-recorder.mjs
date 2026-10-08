export function createVoiceRecorder({ onState, onComplete, onError }) {
  let generation = 0, stream, recorder, tick, limit, started, chunks, bytes;
  function release() {
    clearInterval(tick); clearTimeout(limit);
    stream?.getTracks().forEach(track => track.stop()); stream = null;
  }
  function cancel() {
    generation++;
    if (recorder?.state === 'recording') recorder.stop();
    recorder = null; release(); onState('idle', 0);
  }
  function stop() {
    if (recorder?.state !== 'recording') return;
    recorder.stop(); release(); onState('processing', 0);
  }
  async function start() {
    cancel(); const token = generation;
    onState('requesting', 0);
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (token !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; chunks = []; bytes = 0;
      const active = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96000 });
      recorder = active; started = performance.now();
      active.ondataavailable = event => {
        if (token !== generation || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > 20 * 1024 * 1024) { cancel(); onError('录音超过 20 MB，请缩短录音'); return; }
        chunks.push(event.data);
      };
      active.onerror = () => { if (token === generation) { cancel(); onError('录音设备中断，请重新录制'); } };
      active.onstop = async () => {
        if (token !== generation) return;
        release(); recorder = null; onState('processing', 0);
        try { await onComplete(new Blob(chunks, { type: active.mimeType })); }
        catch (error) { if (token === generation) onError(error.message || '录音保存失败'); }
        finally { if (token === generation) onState('idle', 0); }
      };
      active.start(250); onState('recording', 0);
      tick = setInterval(() => onState('recording', (performance.now() - started) / 1000), 200);
      // Leave a small margin for the encoder's final audio packet.
      limit = setTimeout(stop, 299000);
    } catch (error) {
      if (token !== generation) return;
      cancel();
      onError(({ NotAllowedError: '无法使用麦克风，请在系统隐私设置中允许麦克风访问', NotFoundError: '未找到麦克风，请连接后重试', NotReadableError: '麦克风被占用，请关闭其他录音软件后重试' })[error.name] || '无法开始录音，请检查麦克风');
    }
  }
  return { start, stop, cancel };
}
