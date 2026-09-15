// Official contracts checked 2026-09-14. Provider credentials never enter task records.
// The domestic endpoints below require credentials from the matching domestic console.
const commonRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const arkRatios = [...commonRatios, '21:9', 'adaptive'];
const wanOptions = { resolutions: ['720P', '1080P'], minDuration: 2, maxDuration: 15 };
const arkOptions = { resolutions: ['480p', '720p', '1080p'], minDuration: 4, maxDuration: 15,
  ratios: arkRatios, supportsFirstFrame: true };
const viduOptions = { resolutions: ['540p', '720p', '1080p'], minDuration: 1, maxDuration: 16,
  ratios: commonRatios, supportsFirstFrame: true };

export const DOMESTIC_VIDEO_SPECS = Object.freeze({
  dashscope: {
    id: 'dashscope', name: '通义万相 · 阿里云百炼（北京）',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1&tab=model',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/text-to-video-api-reference',
    models: ['wan2.7-t2v', 'wan2.7-i2v'],
    modelOptions: {
      'wan2.7-t2v': { ...wanOptions, ratios: commonRatios, supportsFirstFrame: false },
      'wan2.7-i2v': { ...wanOptions, ratios: ['adaptive'], supportsFirstFrame: true, requiresFirstFrame: true },
    },
    defaults: { model: 'wan2.7-t2v', resolution: '720P', duration: 5, ratio: '16:9' },
  },
  volcengine: {
    id: 'volcengine', name: 'Seedance · 火山方舟',
    keyUrl: 'https://ark.volcengine.com/region:cn-beijing/apiKey',
    docsUrl: 'https://www.volcengine.com/docs/82379/1520757',
    models: ['doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128',
      'doubao-seedance-2-0-mini-260615', 'doubao-seedance-1-5-pro-251215'],
    modelOptions: {
      'doubao-seedance-2-5-260628': { ...arkOptions, maxDuration: 30 },
      'doubao-seedance-2-0-260128': { ...arkOptions, resolutions: ['480p', '720p', '1080p', '4k'] },
      'doubao-seedance-2-0-fast-260128': { ...arkOptions, resolutions: ['480p', '720p'] },
      'doubao-seedance-2-0-mini-260615': { ...arkOptions, resolutions: ['480p', '720p'] },
      'doubao-seedance-1-5-pro-251215': { ...arkOptions, maxDuration: 12 },
    },
    defaults: { model: 'doubao-seedance-2-5-260628', resolution: '720p', duration: 5, ratio: '16:9' },
  },
  kling: {
    id: 'kling', name: '可灵 Kling（国内）',
    keyUrl: 'https://klingai.com/dev/api-key',
    docsUrl: 'https://klingai.com/document-api',
    models: ['kling-3.0', 'kling-2.6'],
    modelOptions: {
      'kling-3.0': { resolutions: ['720p', '1080p', '4k'], minDuration: 3, maxDuration: 15,
        ratios: ['16:9', '9:16', '1:1'], supportsFirstFrame: true },
      'kling-2.6': { resolutions: ['720p', '1080p'], durations: [5, 10],
        ratios: ['16:9', '9:16', '1:1'], supportsFirstFrame: true },
    },
    defaults: { model: 'kling-3.0', resolution: '720p', duration: 5, ratio: '16:9' },
  },
  vidu: {
    id: 'vidu', name: 'Vidu（国内）', keyUrl: 'https://platform.vidu.cn/',
    docsUrl: 'https://platform.vidu.cn/docs/text-to-video',
    models: ['viduq3-pro', 'viduq3-turbo'],
    modelOptions: { 'viduq3-pro': { ...viduOptions }, 'viduq3-turbo': { ...viduOptions } },
    defaults: { model: 'viduq3-pro', resolution: '720p', duration: 5, ratio: '16:9' },
  },
});

const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
function checkedId(value, provider) {
  if (!validId(value)) throw Error(`${provider} 未返回有效任务 ID；请到平台核对任务，勿自动重新提交`);
  return value;
}
function taskId(id) {
  if (!validId(id)) throw Error('无效的视频任务 ID');
  return encodeURIComponent(id);
}
function redact(value, credential) {
  let result = String(value || '');
  for (const key of typeof credential === 'string' ? [credential] : Object.values(credential || {})) {
    if (typeof key === 'string' && key) result = result.split(key).join('[已隐藏]');
  }
  return result.slice(0, 400);
}
function failed(provider, data, credential) {
  throw Error(`${provider}：${redact(data.message || data.error?.message || data.code || '请求失败', credential)}`);
}
function statusResult(provider, state, statuses, url, error, credential) {
  const status = Object.hasOwn(statuses, state) ? statuses[state] : undefined;
  if (!status) throw Error(`${provider} 返回未知任务状态`);
  return { status, ...(url ? { url } : {}), ...(error ? { error: redact(error, credential) } : {}) };
}
function validateInput(provider, options, maxPrompt) {
  const models = DOMESTIC_VIDEO_SPECS[provider].modelOptions;
  const spec = Object.hasOwn(models, options.model) ? models[options.model] : undefined;
  if (!spec) throw Error('不支持的视频模型');
  if (!spec.resolutions.includes(options.resolution) || !spec.ratios.includes(options.ratio)
    || !Number.isInteger(options.duration) || (spec.durations ? !spec.durations.includes(options.duration)
      : options.duration < spec.minDuration || options.duration > spec.maxDuration)) throw Error('视频分辨率、时长或比例无效');
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > maxPrompt) throw Error(`视频描述不能为空且不能超过 ${maxPrompt} 个字符`);
  if (options.firstFrame && !spec.supportsFirstFrame) throw Error('当前模型不支持首帧图片，请选择图生视频模型');
  if (!options.firstFrame && spec.requiresFirstFrame) throw Error('当前模型需要首帧图片');
  if (options.firstFrame && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(options.firstFrame)) throw Error('首帧图片格式无效');
}

export class DashScopeVideoProvider {
  constructor({ http }) { this.http = http; }
  async request(route, key, options = {}) {
    const data = await this.http.request(`https://dashscope.aliyuncs.com/api/v1${route}`, { key, ...options });
    if (data.code || data.error) failed('通义万相', data, key);
    return data;
  }
  async test(key) {
    const data = await this.request('/tasks?page_no=1&page_size=1', key);
    if (!Array.isArray(data.data)) throw Error('通义万相返回无效任务列表');
    return { message: '连接成功' };
  }
  async create(key, options, signal) {
    validateInput('dashscope', options, 5000);
    const { model, prompt, firstFrame, resolution, duration, ratio } = options;
    const data = await this.request('/services/aigc/video-generation/video-synthesis', key, {
      signal, headers: { 'X-DashScope-Async': 'enable' }, body: {
        model, input: { prompt, ...(firstFrame ? { media: [{ type: 'first_frame', url: firstFrame }] } : {}) },
        parameters: { resolution, duration, ...(!firstFrame ? { ratio } : {}) },
      },
    });
    return checkedId(data.output?.task_id, '通义万相');
  }
  async query(key, id, signal) {
    const data = await this.request(`/tasks/${taskId(id)}`, key, { signal });
    const result = data.output;
    return statusResult('通义万相', result?.task_status, { PENDING: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded',
      FAILED: 'failed', CANCELED: 'cancelled', UNKNOWN: 'failed' }, result?.video_url,
    result?.task_status === 'UNKNOWN' ? '任务不存在或已超过平台保留期限' : result?.message || result?.code, key);
  }
}

export class VolcengineVideoProvider {
  constructor({ http }) { this.http = http; }
  async request(route, key, options = {}) {
    const data = await this.http.request(`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks${route}`, { key, ...options });
    if (data.error && !data.status) failed('火山方舟', data, key);
    return data;
  }
  async test(key) {
    const data = await this.request('?page_num=1&page_size=1', key);
    if (!Array.isArray(data.items)) throw Error('火山方舟返回无效任务列表');
    return { message: '连接成功' };
  }
  async create(key, options, signal) {
    validateInput('volcengine', options, 10000);
    const { model, prompt, firstFrame, resolution, duration, ratio } = options;
    const content = [{ type: 'text', text: prompt }];
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' });
    const data = await this.request('', key, { signal, body: { model, content, resolution, duration,
      ratio: firstFrame && model.startsWith('doubao-seedance-2-5-') ? 'adaptive' : ratio } });
    return checkedId(data.id, '火山方舟');
  }
  async query(key, id, signal) {
    const data = await this.request(`/${taskId(id)}`, key, { signal });
    return statusResult('火山方舟', data.status, { queued: 'queued', running: 'running', succeeded: 'succeeded',
      failed: 'failed', cancelled: 'cancelled', expired: 'failed' }, data.content?.video_url,
    data.error?.message || (data.status === 'expired' ? '任务已超时' : ''), key);
  }
}

// Current Kling APIs use a single API Key; legacy AK/SK JWT is not valid for these routes.
// https://klingai.com/document-api — get-started/authentication and video/3-0-omni.
export class KlingVideoProvider {
  constructor({ http }) { this.http = http; }
  async request(route, key, options = {}) {
    const data = await this.http.request(`https://api-beijing.klingai.com${route}`, { key, ...options });
    if (data.code !== 0) failed('可灵', data, key);
    return data;
  }
  async test(key) {
    // POST /tasks is the documented read-only cursor/list operation, not generation.
    const data = await this.request('/tasks', key, { body: { limit: 1 } });
    if (!Array.isArray(data.data?.result)) throw Error('可灵返回无效任务列表');
    return { message: '连接成功' };
  }
  async create(key, options, signal) {
    validateInput('kling', options, options.model === 'kling-3.0' ? 3072 : 2500);
    const { model, prompt, firstFrame, resolution, duration, ratio } = options;
    if (firstFrame?.startsWith('data:image/webp;')) throw Error('可灵首帧仅支持 PNG 或 JPEG 图片');
    const body = firstFrame ? { contents: [{ type: 'prompt', text: prompt },
      { type: 'first_frame', url: firstFrame.replace(/^data:image\/\w+;base64,/, '') }] } : { prompt };
    body.settings = { resolution, duration, ...(!firstFrame ? { aspect_ratio: ratio } : {}) };
    const data = await this.request(`/${firstFrame ? 'image-to-video' : 'text-to-video'}/${model}`, key, { signal, body });
    return checkedId(data.data?.id, '可灵');
  }
  async query(key, id, signal) {
    const data = await this.request(`/tasks?task_ids=${taskId(id)}`, key, { signal });
    const result = data.data?.find?.(item => item.id === id);
    if (!result) throw Error('可灵未返回该任务，请检查任务 ID 或平台保留期限');
    return statusResult('可灵', result.status, { submitted: 'queued', processing: 'running', succeeded: 'succeeded',
      failed: 'failed', cancelled: 'cancelled' }, result.outputs?.find(item => item.type === 'video')?.url,
    result.status === 'failed' ? result.message : '', key);
  }
}

export class ViduVideoProvider {
  constructor({ http }) { this.http = http; }
  async request(route, key, options = {}) {
    const data = await this.http.request(`https://api.vidu.cn/ent/v2${route}`, { key, ...options,
      headers: { ...options.headers, Authorization: `Token ${key}` } });
    if (data.code || data.error) failed('Vidu', data, key);
    return data;
  }
  async test(key) {
    const data = await this.request('/credits', key);
    if (!Array.isArray(data.remains)) throw Error('Vidu 返回无效账户信息');
    return { message: '连接成功' };
  }
  async create(key, options, signal) {
    validateInput('vidu', options, 5000);
    const { model, prompt, firstFrame, resolution, duration, ratio } = options;
    const body = { model, prompt, resolution, duration, ...(firstFrame ? { images: [firstFrame] } : { aspect_ratio: ratio }) };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 20_000_000) throw Error('首帧图片编码后超过 Vidu 的 20 MB 请求限制，请缩小图片');
    const data = await this.request(firstFrame ? '/img2video' : '/text2video', key, { signal,
      body });
    return checkedId(data.task_id, 'Vidu');
  }
  async query(key, id, signal) {
    const data = await this.request(`/tasks/${taskId(id)}/creations`, key, { signal });
    return statusResult('Vidu', data.state, { created: 'queued', queueing: 'queued', processing: 'running', success: 'succeeded',
      failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled' }, data.creations?.[0]?.url, data.err_code, key);
  }
}

export function createDomesticProviders(http) {
  return { dashscope: new DashScopeVideoProvider({ http }), volcengine: new VolcengineVideoProvider({ http }),
    kling: new KlingVideoProvider({ http }), vidu: new ViduVideoProvider({ http }) };
}
