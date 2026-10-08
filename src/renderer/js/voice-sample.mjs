// MiniMax upload requirements: https://platform.minimax.cn/docs/api-reference/voice-cloning-uploadcloneaudio
// Recommended recording length is a product suggestion; the API accepts 10–300 seconds.
export const VOICE_SAMPLE_GUIDE = Object.freeze({
  minSeconds: 10, maxSeconds: 300, maxBytes: 20 * 1024 * 1024,
  recommendedSeconds: [30, 60], formats: ['mp3', 'm4a', 'wav'],
  readingText: '早上好，很高兴在这里和你见面。清晨的阳光照进房间，窗外的树叶轻轻摇动。我给自己倒了一杯温水，准备开始今天的工作。\n\n如果有三天假期，你会去哪里？我想去海边走走，听听风声，再找一家安静的小店，尝一尝当地的味道。光是想到这些，就觉得很开心。\n\n现在，让我们看一个简单的例子：一份计划，三个步骤，大约需要二十分钟。先把问题说清楚，再认真比较，最后做出选择。别着急，我们可以慢慢来。谢谢你的耐心，期待下次再见。',
});

export function encodeVoiceWav(buffer) {
  const bytes = new Uint8Array(44 + buffer.length * 2), view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < buffer.length; i++) {
    const value = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function analyzeVoiceSample(buffer) {
  const { duration, sampleRate, numberOfChannels: channels, length } = buffer || {};
  if (!Number.isFinite(duration) || !Number.isFinite(sampleRate) || !Number.isInteger(length) || length < 1) throw Error('无法读取录音，请选择有效的音频文件');
  if (duration < VOICE_SAMPLE_GUIDE.minSeconds) throw Error('录音至少需要 10 秒，建议录制 30–60 秒');
  if (duration > VOICE_SAMPLE_GUIDE.maxSeconds) throw Error('录音不能超过 5 分钟，请先剪短后导入');
  if (!Number.isInteger(channels) || channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 192000) throw Error('录音声道或采样率不支持，请使用单声道或双声道录音');
  const data = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  const windowLength = Math.max(1, Math.round(sampleRate * .02));
  let sum = 0, clipped = 0, silent = 0, windows = 0, peak = 0;
  for (let start = 0; start < length; start += windowLength) {
    const end = Math.min(length, start + windowLength);
    let energy = 0;
    for (let i = start; i < end; i++) {
      for (const channel of data) {
        const value = channel[i];
        if (!Number.isFinite(value)) throw Error('录音数据损坏，请重新导入');
        energy += value * value;
        peak = Math.max(peak, Math.abs(value));
        if (Math.abs(value) >= .995) clipped++;
      }
    }
    sum += energy;
    if (Math.sqrt(energy / ((end - start) * channels)) < .008) silent++;
    windows++;
  }
  if (peak < .0001) throw Error('录音没有可听见的声音，请重新录制');
  const rms = Math.sqrt(sum / (length * channels));
  const clippingRatio = clipped / (length * channels), silentRatio = silent / windows;
  const warnings = [];
  if (rms < .015) warnings.push('音量较低，建议靠近麦克风重录');
  if (clippingRatio > .01) warnings.push('可能有破音，建议调低录音音量');
  if (silentRatio > .65) warnings.push('静音较多，建议剪掉长时间停顿');
  // Signal measurements cannot establish speaker count, background music or voice identity.
  return { duration, sampleRate, channels, rms, clippingRatio, silentRatio, warnings };
}

export function estimateSpeechSeconds(text) {
  const value = String(text || '');
  const chinese = (value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  const words = (value.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
  return chinese / 4 + words / 2.5;
}

export function planSpeechSegments(text, maxSeconds = 15) {
  const value = String(text || '');
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw Error('分段时长无效');
  if (!value.trim()) return [];
  const parts = value.match(/[^。！？.!?，,；;\n]+[。！？.!?，,；;\n]*|[。！？.!?，,；;\n]+/gu) || [value];
  const segments = [];
  let current = '';
  const append = part => {
    if (current && estimateSpeechSeconds(current + part) > maxSeconds) { segments.push(current); current = ''; }
    current += part;
  };
  for (const part of parts) {
    if (estimateSpeechSeconds(part) <= maxSeconds) append(part);
    else {
      // Split at words or Chinese characters without rewriting the user's lines.
      for (const token of part.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s]+\s*|\s+/gu) || []) append(token);
    }
  }
  if (current) segments.push(current);
  return segments;
}
