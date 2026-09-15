// Official contracts: https://ai.google.dev/gemini-api/docs/veo
// https://docs.dev.runwayml.com/api/ and https://docs.agents.lumalabs.ai/guides/videos/generation/
const VEO_MODELS = ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview'];
const WIDE_RATIOS = ['16:9', '9:16'];
const VEO_ORIGIN = 'https://generativelanguage.googleapis.com';
const VEO_BASE = `${VEO_ORIGIN}/v1beta`;
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
const LUMA_BASE = 'https://agents.lumalabs.ai/v1';
const RUNWAY_HEADERS = { 'X-Runway-Version': '2024-11-06' };

export const INTERNATIONAL_VIDEO_SPECS = Object.freeze({
  google: {
    id: 'google', name: 'Google Veo', keyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs/veo',
    models: VEO_MODELS,
    modelOptions: Object.fromEntries(VEO_MODELS.map(model => [model, {
      resolutions: model.includes('lite') ? ['720P', '1080P'] : ['720P', '1080P', '4K'],
      durations: [4, 6, 8], durationsByResolution: { '720P': [4, 6, 8], '1080P': [8], '4K': [8] },
      ratios: WIDE_RATIOS, supportsFirstFrame: true,
    }])),
    defaults: { model: VEO_MODELS[0], resolution: '720P', duration: 8, ratio: '16:9' },
  },
  runway: {
    id: 'runway', name: 'Runway', keyUrl: 'https://dev.runwayml.com/', docsUrl: 'https://docs.dev.runwayml.com/guides/setup/',
    models: ['gen4.5', 'gen4_turbo'],
    modelOptions: {
      'gen4.5': { resolutions: ['720P'], minDuration: 2, maxDuration: 10, ratios: WIDE_RATIOS, supportsFirstFrame: true },
      gen4_turbo: { resolutions: ['720P'], minDuration: 2, maxDuration: 10, ratios: WIDE_RATIOS, supportsFirstFrame: true, requiresFirstFrame: true },
    },
    defaults: { model: 'gen4.5', resolution: '720P', duration: 5, ratio: '16:9' },
  },
  luma: {
    id: 'luma', name: 'Luma', keyUrl: 'https://platform.lumalabs.ai/', docsUrl: 'https://docs.agents.lumalabs.ai/guides/videos/generation/',
    models: ['ray-3.2'],
    modelOptions: { 'ray-3.2': { resolutions: ['360P', '540P', '720P', '1080P'], durations: [5, 10],
      ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], supportsFirstFrame: true } },
    defaults: { model: 'ray-3.2', resolution: '720P', duration: 5, ratio: '16:9' },
  },
});

function apiKey(credential) {
  const value = typeof credential === 'string' ? credential : credential?.apiKey;
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw Error('请先配置 API Key');
  return value.trim();
}
function redact(value, credential) {
  const key = apiKey(credential);
  return String(value || '').split(key).join('[已隐藏]').slice(0, 400);
}
function imageData(uri, maxBytes = 20 * 1024 * 1024) {
  const match = typeof uri === 'string' && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
  if (!match) throw Error('首帧必须为 PNG、JPEG 或 WebP 图片');
  if (Buffer.byteLength(match[2], 'base64') > maxBytes) throw Error(`首帧图片超过 ${maxBytes / 1024 / 1024} MB`);
  return { mimeType: match[1], data: match[2] };
}
function validate(provider, options, maxPrompt) {
  const spec = INTERNATIONAL_VIDEO_SPECS[provider];
  const rules = Object.hasOwn(spec.modelOptions, options.model) ? spec.modelOptions[options.model] : null;
  if (!rules || !rules.resolutions.includes(options.resolution) || !rules.ratios.includes(options.ratio)
    || !Number.isInteger(options.duration)
    || (rules.durations ? !rules.durations.includes(options.duration) : options.duration < rules.minDuration || options.duration > rules.maxDuration)) throw Error(`${spec.name} 视频参数无效`);
  if (rules.durationsByResolution && !rules.durationsByResolution[options.resolution]?.includes(options.duration)) throw Error(`${spec.name} ${options.resolution} 仅支持 8 秒视频`);
  if (rules.requiresFirstFrame && !options.firstFrame) throw Error(`${options.model} 需要首帧图片`);
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > maxPrompt) throw Error(`${spec.name} 提示词须为 1–${maxPrompt} 个字符`);
}
function taskId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error('无效的视频任务 ID');
  return id;
}
function createdId(id, provider) {
  try { return taskId(id); } catch { throw Error(`${provider} 未返回有效任务 ID；请到平台核对任务，勿自动重新提交`); }
}
function statusFrom(value, mapping, provider) {
  if (typeof value !== 'string' || !Object.hasOwn(mapping, value)) throw Error(`${provider} 返回未知任务状态`);
  return mapping[value];
}

export class GoogleVideoProvider {
  constructor({ http }) { this.http = http; }
  request(route, credential, options = {}) {
    return this.http.request(`${VEO_BASE}/${route}`, { ...options, headers: { 'x-goog-api-key': apiKey(credential) } });
  }
  async test(credential) {
    const data = await this.request('models?pageSize=1', credential);
    if (!data || !Array.isArray(data.models)) throw Error('Google 返回无效模型列表');
    return { message: '连接成功' };
  }
  operation(name) {
    const match = typeof name === 'string' && /^models\/([A-Za-z0-9.-]+)\/operations\/([A-Za-z0-9_-]{1,256})$/.exec(name);
    if (!match || !VEO_MODELS.includes(match[1])) throw Error('无效的 Google 视频任务 ID');
    return name;
  }
  async create(credential, options, signal) {
    validate('google', options, 6000);
    const { model, prompt, firstFrame, duration, resolution, ratio } = options;
    let image = {};
    if (firstFrame) {
      const frame = imageData(firstFrame);
      // Match the official Gen AI SDK wire conversion, not generateContent's inlineData shape.
      image = { image: { mimeType: frame.mimeType, bytesBase64Encoded: frame.data } };
    }
    const data = await this.request(`models/${model}:predictLongRunning`, credential, {
      body: { instances: [{ prompt, ...image }], parameters: { sampleCount: 1, durationSeconds: duration,
        resolution: resolution.toLowerCase(), aspectRatio: ratio } }, signal,
    });
    try { return this.operation(data?.name); } catch { throw Error('Google 未返回有效任务 ID；请到平台核对任务，勿自动重新提交'); }
  }
  async query(credential, id, signal) {
    const data = await this.request(this.operation(id), credential, { signal });
    if (data?.error) return { status: 'failed', error: redact(data.error.message || data.error.code, credential) };
    if (data?.done !== true) {
      if (data?.done === false || data?.name === id) return { status: 'running' };
      throw Error('Google 返回未知任务状态');
    }
    const result = data.response?.generateVideoResponse;
    const url = result?.generatedSamples?.[0]?.video?.uri;
    if (!url) return { status: 'failed', error: redact(result?.raiMediaFilteredReasons?.join('；') || 'Google 未返回视频，可能未通过平台审核', credential) };
    // API keys are needed by the Files download endpoint; never forward them to arbitrary CDN redirects.
    return { status: 'succeeded', url, downloadHeaders: { 'x-goog-api-key': apiKey(credential) }, downloadAuthOrigins: [VEO_ORIGIN] };
  }
}

export class RunwayVideoProvider {
  constructor({ http }) { this.http = http; }
  request(route, credential, options = {}) {
    return this.http.request(`${RUNWAY_BASE}/${route}`, { ...options, key: apiKey(credential), headers: RUNWAY_HEADERS });
  }
  async test(credential) {
    const data = await this.request('organization', credential);
    if (typeof data?.creditBalance !== 'number') throw Error('Runway 返回无效账户信息');
    return { message: '连接成功' };
  }
  async create(credential, options, signal) {
    validate('runway', options, 1000);
    const { model, prompt, firstFrame, duration, ratio } = options;
    if (firstFrame) {
      imageData(firstFrame, 5 * 1024 * 1024);
      // Runway's 5 MB limit applies to the encoded data URI, not the decoded image.
      if (Buffer.byteLength(firstFrame, 'utf8') > 5_000_000) throw Error('首帧图片编码后超过 Runway 的 5 MB 限制，请缩小图片');
    }
    const data = await this.request(firstFrame ? 'image_to_video' : 'text_to_video', credential, {
      body: { model, promptText: prompt, duration, ratio: ratio === '16:9' ? '1280:720' : '720:1280',
        ...(firstFrame ? { promptImage: firstFrame } : {}) }, signal,
    });
    return createdId(data?.id, 'Runway');
  }
  async query(credential, id, signal) {
    const data = await this.request(`tasks/${taskId(id)}`, credential, { signal });
    const status = statusFrom(data?.status, { PENDING: 'queued', THROTTLED: 'queued', RUNNING: 'running',
      SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELLED: 'cancelled' }, 'Runway');
    return { status, url: data.output?.[0], error: redact(data.failure || data.failureCode, credential) };
  }
}

export class LumaVideoProvider {
  constructor({ http }) { this.http = http; }
  request(route, credential, options = {}) {
    return this.http.request(`${LUMA_BASE}/${route}`, { ...options, key: apiKey(credential) });
  }
  async test(credential) {
    const data = await this.request('files?limit=1', credential);
    if (!Array.isArray(data?.data)) throw Error('Luma 返回无效文件列表');
    return { message: '连接成功' };
  }
  async create(credential, options, signal) {
    validate('luma', options, 6000);
    const { model, prompt, firstFrame, duration, resolution, ratio } = options;
    let frames = {};
    if (firstFrame) {
      const image = imageData(firstFrame);
      // Current keyframe API supports both 5s and 10s; legacy start_frame is restricted to 5s.
      frames = { keyframes: [{ data: image.data, media_type: image.mimeType }], keyframe_indexes: [0] };
    }
    const data = await this.request('generations', credential, { body: { model, type: 'video', prompt,
      aspect_ratio: ratio, video: { resolution: resolution.toLowerCase(), duration: `${duration}s`, ...frames } }, signal });
    return createdId(data?.id, 'Luma');
  }
  async query(credential, id, signal) {
    const data = await this.request(`generations/${taskId(id)}`, credential, { signal });
    const status = statusFrom(data?.state, { queued: 'queued', processing: 'running', completed: 'succeeded', failed: 'failed' }, 'Luma');
    return { status, url: data.output?.find(item => item.type === 'video')?.url,
      error: redact(data.failure_reason || data.failure_code, credential) };
  }
}

export function createInternationalProviders(http) {
  return { google: new GoogleVideoProvider({ http }), runway: new RunwayVideoProvider({ http }), luma: new LumaVideoProvider({ http }) };
}
