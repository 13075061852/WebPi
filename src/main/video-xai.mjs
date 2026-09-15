// https://docs.x.ai/developers/model-capabilities/video/generation
import { redactVideoError } from './video-http.mjs';

export const XAI_VIDEO_SPECS = {
  xai: { id: 'xai', name: 'Grok', keyUrl: 'https://console.x.ai/team/default/api-keys',
    docsUrl: 'https://docs.x.ai/developers/model-capabilities/video/generation', models: ['grok-imagine-video-1.5'],
    modelOptions: { 'grok-imagine-video-1.5': { resolutions: ['480P', '720P', '1080P'], minDuration: 1, maxDuration: 15,
      ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'], supportsFirstFrame: true } },
    defaults: { model: 'grok-imagine-video-1.5', resolution: '720P', duration: 5, ratio: '16:9' } },
};
const idValid = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export class XaiVideoProvider {
  constructor({ http }) { this.http = http; }
  request(route, key, options = {}) { return this.http.request(`https://api.x.ai/v1/${route}`, { ...options, key }); }
  async test(key) {
    const data = await this.request('models', key);
    if (!Array.isArray(data?.data)) throw Error('Grok 返回无效模型列表');
    return { message: '连接成功' };
  }
  async create(key, { model, prompt, firstFrame, duration, resolution, ratio }, signal) {
    const data = await this.request('videos/generations', key, { signal, body: { model, prompt, duration,
      resolution: resolution.toLowerCase(), aspect_ratio: ratio, ...(firstFrame ? { image: { url: firstFrame } } : {}) } });
    if (!idValid(data.request_id)) throw Error('Grok 未返回有效任务 ID；请到平台核对任务，勿自动重新提交');
    return data.request_id;
  }
  async query(key, id, signal) {
    if (!idValid(id)) throw Error('无效的视频任务 ID');
    const data = await this.request(`videos/${id}`, key, { signal });
    const status = { pending: 'running', done: 'succeeded', expired: 'failed', failed: 'failed' };
    if (!Object.hasOwn(status, data.status)) throw Error('Grok 返回未知任务状态');
    if (data.video?.respect_moderation === false) return { status: 'failed', error: '视频未通过平台审核' };
    return { status: status[data.status], url: data.video?.url,
      error: redactVideoError(data.error?.message || data.error || (data.status === 'expired' ? '任务已过期' : ''), [key]) };
  }
}
