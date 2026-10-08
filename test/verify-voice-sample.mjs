import assert from 'node:assert/strict';
import { VOICE_SAMPLE_GUIDE, encodeVoiceWav, analyzeVoiceSample, estimateSpeechSeconds, planSpeechSegments } from '../src/renderer/js/voice-sample.mjs';

function sample(duration, value = index => .2 * Math.sin(index / 8), channels = 1) {
  const sampleRate = 8000, length = Math.round(duration * sampleRate);
  const data = Float32Array.from({ length }, (_, index) => value(index));
  return { duration, sampleRate, length, numberOfChannels: channels, getChannelData: () => data };
}
assert.equal(VOICE_SAMPLE_GUIDE.minSeconds, 10);
assert.equal(VOICE_SAMPLE_GUIDE.maxSeconds, 300);
assert.deepEqual(VOICE_SAMPLE_GUIDE.formats, ['mp3', 'm4a', 'wav']);
assert.throws(() => analyzeVoiceSample(sample(9.99)), /至少需要 10 秒/);
assert.throws(() => analyzeVoiceSample(sample(300.001)), /超过 5 分钟/);
for (const duration of [10, 30.125, 300]) {
  const result = analyzeVoiceSample(sample(duration));
  assert.equal(result.duration, duration);
  assert.equal(result.channels, 1);
  assert.ok(result.rms > .1 && result.rms < .2);
  assert.deepEqual(result.warnings, []);
}
assert.throws(() => analyzeVoiceSample(sample(15, () => 0)), /没有可听见的声音/);
assert.throws(() => analyzeVoiceSample(sample(15, () => NaN)), /数据损坏/);
assert.throws(() => analyzeVoiceSample(sample(15, undefined, 3)), /声道/);
assert.ok(analyzeVoiceSample(sample(15, () => .002)).warnings.some(message => message.includes('音量较低')));
assert.ok(analyzeVoiceSample(sample(15, i => i % 2 ? 1 : -1)).warnings.some(message => message.includes('破音')));
const gaps = analyzeVoiceSample(sample(15, i => i < 100000 ? 0 : .2));
assert.ok(gaps.warnings.some(message => message.includes('静音较多')));
assert.equal(analyzeVoiceSample(sample(15, undefined, 2)).channels, 2);
assert.equal(estimateSpeechSeconds(''), 0);
assert.equal(estimateSpeechSeconds('你好世界'), 1);
assert.equal(estimateSpeechSeconds('hello to the whole world'), 2);
assert.ok(estimateSpeechSeconds(VOICE_SAMPLE_GUIDE.readingText) >= 30);
assert.ok(estimateSpeechSeconds(VOICE_SAMPLE_GUIDE.readingText) <= 60);
for (const text of [
  '  今天想介绍产品。\n第二段内容不会丢失！',
  '连续没有标点的中文台词'.repeat(20),
  'This is a long English script, and every word must remain exactly as written. '.repeat(12),
  '中文和 English words 一起出现，\n  包含空格、引号“你好”、数字123和表情🙂。'.repeat(10),
]) {
  const chunks = planSpeechSegments(text);
  assert.equal(chunks.join(''), text, 'Keep every character, space and punctuation in the suggested segments');
  assert.ok(chunks.every(chunk => estimateSpeechSeconds(chunk) <= 15));
}
assert.deepEqual(planSpeechSegments(''), []);
assert.throws(() => planSpeechSegments('test', 0), /时长/);
console.log('PASS exact audio duration boundaries, signal quality warnings, silent/corrupt rejection and lossless mixed-language speech planning');

const wav = new DataView(encodeVoiceWav(sample(10, () => .5, 2)).buffer);
assert.equal(wav.getUint32(24, true), 8000);
assert.equal(wav.getUint16(22, true), 1);
assert.equal(wav.getUint32(40, true), 160000);
assert.equal(wav.getInt16(44, true), 16384);
