// Contracts: https://docs.apimart.ai/cn/api-reference/videos/{model}/generation
// https://docs.apimart.ai/cn/api-reference/tasks/status
// https://docs.apimart.ai/cn/api-reference/uploads/images
import { redactVideoError } from './video-http.mjs';

const WIDE = ['16:9', '9:16'];
const RATIOS = [...WIDE, '1:1', '4:3', '3:4'];
const rules = (resolutions, minDuration, maxDuration, ratios = RATIOS) => ({
  resolutions, minDuration, maxDuration, ratios, supportsFirstFrame: true,
});
const modelOptions = {
  'MiniMax-H3': rules(['768P', '2K'], 4, 15, [...RATIOS, '21:9']),
  'seedance-2.5': rules(['480P', '720P', '1080P'], 4, 30, [...RATIOS, '21:9', 'adaptive']),
  'seedance-2.0': rules(['480P', '720P', '1080P', '4K'], 4, 15, [...RATIOS, '21:9', 'adaptive']),
  ...Object.fromEntries(['seedance-2.0-fast', 'seedance-2.0-mini'].map(model => [model,
    rules(['480P', '720P'], 4, 15, [...RATIOS, '21:9', 'adaptive'])])),
  ...Object.fromEntries(['sora-2', 'sora-2-pro'].map(model => [model, {
    ...rules(model === 'sora-2' ? ['720P'] : ['720P', '1024P', '1080P'], 4, 20, WIDE), durations: [4, 8, 12, 16, 20],
  }])),
  ...Object.fromEntries(['veo3.1-fast', 'veo3.1-quality', 'veo3.1-lite'].map(model => [model, {
    ...rules(['720P', '1080P', '4K'], 8, 8, WIDE), durations: [8], supportsFirstFrame: model !== 'veo3.1-lite',
  }])),
  ...Object.fromEntries(['veo3.1-fast-official', 'veo3.1-quality-official'].map(model => [model, {
    ...rules(['720P', '1080P', '4K'], 4, 8, WIDE), durations: [4, 6, 8],
  }])),
  'kling-v3': rules(['720P', '1080P', '4K'], 3, 15, [...WIDE, '1:1']),
  ...Object.fromEntries(['viduq3-pro', 'viduq3-turbo'].map(model => [model, rules(['540P', '720P', '1080P'], 1, 16)])),
  ...Object.fromEntries(['grok-imagine-video', 'grok-imagine-video-1.5'].map(model => [model,
    rules(model.endsWith('1.5') ? ['480P', '720P', '1080P'] : ['480P', '720P'], 1, 15, [...RATIOS, '3:2', '2:3'])])),
  'wan2.6': { ...rules(['720P', '1080P'], 5, 15), durations: [5, 10, 15] },
};
export const APIMART_VIDEO_SPECS = {
  apimart: { id: 'apimart', name: 'APIMart', keyUrl: 'https://apimart.ai/keys', docsUrl: 'https://docs.apimart.ai/cn',
    models: Object.keys(modelOptions), modelOptions,
    defaults: { model: 'MiniMax-H3', resolution: '768P', duration: 5, ratio: '16:9' } },
};
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validURL = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
export class ApimartVideoProvider {
  constructor({ http }) { this.http = http; }
  async request(route, key, options = {}) {
    const data = await this.http.request(`https://api.apimart.ai/v1/${route}`, { ...options, key });
    if (!data || data.error || data.success === false || (data.code !== undefined && data.code !== 200)) {
      throw Error(`APIMart：${redactVideoError(data?.error?.message || data?.message || '接口返回失败', [key])}`);
    }
    return data;
  }
  async test(key) {
    const data = await this.request('balance', key);
    if (data.success !== true) throw Error('APIMart 返回无效密钥状态');
    return { message: '连接成功' };
  }
  async balance(key) {
    const data = await this.request('user/balance', key, { timeoutMs: 12000 });
    if (data.success !== true) throw Error('APIMart 账户余额查询失败');
    const valid = value => typeof value === 'number' && Number.isFinite(value);
    const amount = valid(data.remain_credits) ? data.remain_credits
      : valid(data.remain_balance) ? data.remain_balance * 10 : null;
    if (amount === null) throw Error('APIMart 未返回有效账户余额');
    return { available: true, amount: Number(amount.toFixed(8)), unit: 'Credits', scope: 'account' };
  }
  async upload(key, firstFrame, maxBytes, signal) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(firstFrame);
    if (!match) throw Error('APIMart 首帧须为 PNG、JPEG 或 WebP 图片');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > maxBytes) throw Error(`APIMart 首帧图片最大 ${maxBytes / 1024 / 1024} MB`);
    const body = new FormData();
    body.append('file', new Blob([bytes], { type: match[1] }), `first-frame.${match[1].split('/')[1]}`);
    const data = await this.request('uploads/images', key, { body, signal });
    if (!validURL(data.url)) throw Error('APIMart 未返回有效图片地址');
    return data.url;
  }
  async create(key, { model, prompt, firstFrame, duration, resolution, ratio }, signal) {
    if (!Object.hasOwn(modelOptions, model)) throw Error('APIMart 不支持的视频模型');
    if (firstFrame && !modelOptions[model].supportsFirstFrame) throw Error('当前模型不支持首帧图片');
    const body = { model, prompt, duration, resolution: resolution.toLowerCase(), aspect_ratio: ratio };
    if (model === 'MiniMax-H3') body.resolution = resolution;
    if (model.startsWith('veo3.1-') && model.endsWith('-official') && resolution === '4K') body.resolution = '4K';
    if (model === 'kling-v3') {
      body.mode = { '720P': 'std', '1080P': 'pro', '4K': '4k' }[resolution];
      delete body.resolution;
    }
    if (model.startsWith('seedance-')) { body.size = ratio; delete body.aspect_ratio; }
    if (firstFrame) {
      const smallImage = model.startsWith('sora-') || (model.startsWith('veo3.1-') && !model.endsWith('-official'));
      const url = await this.upload(key, firstFrame, (smallImage ? 10 : 20) * 1024 * 1024, signal);
      if (model.startsWith('seedance-')) {
        body.image_with_roles = [{ url, role: 'first_frame' }];
        body.size = 'adaptive';
      } else if (model === 'MiniMax-H3' || model.endsWith('-official')) {
        body.first_frame_image = url;
        if (model === 'MiniMax-H3') delete body.aspect_ratio;
      } else {
        body.image_urls = [url];
        if (model.startsWith('viduq3-') || model.startsWith('sora-') || model === 'wan2.6') delete body.aspect_ratio;
      }
    }
    const data = await this.request('videos/generations', key, { body, signal });
    const id = data.data?.[0]?.task_id;
    if (!validId(id)) throw Error('APIMart 未返回有效任务 ID；请到平台核对任务，勿自动重新提交');
    return id;
  }
  async query(key, id, signal) {
    if (!validId(id)) throw Error('无效的视频任务 ID');
    const { data } = await this.request(`tasks/${id}?language=zh`, key, { signal });
    const statuses = { pending: 'queued', submitted: 'queued', processing: 'running', completed: 'succeeded', failed: 'failed', cancelled: 'cancelled' };
    if (!data || !Object.hasOwn(statuses, data.status)) throw Error('APIMart 返回未知任务状态');
    const result = data.result?.videos?.[0]?.url;
    const url = Array.isArray(result) ? result[0] : result;
    if (data.status === 'completed' && !validURL(url)) throw Error('APIMart 视频结果缺少有效下载地址，请保留任务 ID 重试查询');
    const actual = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const rounded = n => Number(n.toFixed(8));
    const terminal = ['completed', 'failed', 'cancelled'].includes(data.status);
    const source = terminal && actual(data.credits_cost) ? 'credits_cost' : terminal && actual(data.cost) ? 'cost_usd_x10' : null;
    // These are settled amounts. Never apply public pricing discounts a second time.
    const usage = source ? { amount: rounded(source === 'credits_cost' ? data.credits_cost : data.cost * 10), unit: 'Credits' } : undefined;
    const billing = { source, status: data.status,
      ...Object.fromEntries(['credits_cost', 'cost', 'created', 'completed', 'actual_time'].filter(field => actual(data[field])).map(field => [field, data[field]])) };
    const generationMs = terminal && actual(data.actual_time) ? data.actual_time * 1000 : undefined;
    return { status: statuses[data.status], url, ...(usage ? { usage } : {}), billing, generationMs,
      error: data.error ? redactVideoError(data.error.message || data.error, [key]) : '' };
  }
}
