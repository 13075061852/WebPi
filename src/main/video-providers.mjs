import { VideoHTTP, redactVideoError } from './video-http.mjs';
import { DOMESTIC_VIDEO_SPECS, createDomesticProviders } from './video-domestic.mjs';
import { INTERNATIONAL_VIDEO_SPECS, createInternationalProviders } from './video-international.mjs';
import { XAI_VIDEO_SPECS, XaiVideoProvider } from './video-xai.mjs';
import { APIMART_VIDEO_SPECS, ApimartVideoProvider } from './video-apimart.mjs';
// Settings and tools use the same model capabilities.
// https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create
export const VIDEO_PROVIDERS = Object.freeze({
  minimax: { id: 'minimax', name: 'MiniMax', keyUrl: 'https://platform.minimax.cn/console/access?tab=api-keys',
    docsUrl: 'https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create', models: ['MiniMax-H3'],
    modelOptions: { 'MiniMax-H3': { resolutions: ['768P', '2K'],
      ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], minDuration: 4, maxDuration: 15, supportsFirstFrame: true } },
    defaults: { model: 'MiniMax-H3', resolution: '768P', duration: 5, ratio: '16:9' } },
  ...DOMESTIC_VIDEO_SPECS, ...INTERNATIONAL_VIDEO_SPECS, ...XAI_VIDEO_SPECS, ...APIMART_VIDEO_SPECS,
});

export function videoSpec(provider) {
  const spec = Object.hasOwn(VIDEO_PROVIDERS, provider) && VIDEO_PROVIDERS[provider];
  if (!spec) throw Error('不支持的视频平台');
  return spec;
}
export function validateVideoOptions(provider, input = {}) {
  const spec = videoSpec(provider);
  const options = { ...spec.defaults, ...input };
  const rules = Object.hasOwn(spec.modelOptions, options.model) && spec.modelOptions[options.model];
  if (!rules) throw Error(`${spec.name} 视频模型无效：${String(options.model)}。请使用 models 查看可用模型`);
  const invalid = (field, value, allowed) => { throw Error(`${spec.name} / ${options.model}：${field}无效（${String(value)}），可选：${allowed}。请修正参数，不要更换模型`); };
  // Providers use both "720P" and "720p"; accept either without changing resolution.
  const resolution = typeof options.resolution === 'string' && rules.resolutions.find(value => value.toLowerCase() === options.resolution.trim().toLowerCase());
  if (!resolution) invalid('分辨率', options.resolution, rules.resolutions.join('、'));
  options.resolution = resolution;
  if (!rules.ratios.includes(options.ratio)) invalid('比例', options.ratio, rules.ratios.join('、'));
  const durations = rules.durationsByResolution?.[resolution] || rules.durations;
  if (!Number.isInteger(options.duration) || (durations ? !durations.includes(options.duration) : options.duration < rules.minDuration || options.duration > rules.maxDuration)) {
    invalid('时长', options.duration, durations ? `${durations.join('、')} 秒` : `${rules.minDuration}–${rules.maxDuration} 秒（整数）`);
  }
  return Object.fromEntries(['model', 'resolution', 'duration', 'ratio'].map(key => [key, options[key]]));
}

export function videoModelDefaults(provider, model = videoSpec(provider).defaults.model) {
  const spec = videoSpec(provider), rules = Object.hasOwn(spec.modelOptions, model) && spec.modelOptions[model];
  if (!rules) throw Error('不支持的视频模型');
  const resolution = rules.resolutions.includes(spec.defaults.resolution) ? spec.defaults.resolution : rules.resolutions[0];
  const ratio = rules.ratios.includes(spec.defaults.ratio) ? spec.defaults.ratio : rules.ratios[0];
  const durations = rules.durationsByResolution?.[resolution] || rules.durations;
  const duration = durations ? (durations.includes(spec.defaults.duration) ? spec.defaults.duration : durations[0])
    : Math.min(rules.maxDuration, Math.max(rules.minDuration, spec.defaults.duration));
  return { model, resolution, ratio, duration };
}

export function createVideoProviders(options = {}) {
  const http = new VideoHTTP(options);
  return { minimax: new MiniMaxVideoProvider({ http }), ...createDomesticProviders(http), ...createInternationalProviders(http), xai: new XaiVideoProvider({ http }), apimart: new ApimartVideoProvider({ http }) };
}

export class MiniMaxVideoProvider {
  constructor({ http, ...options } = {}) { this.http = http || new VideoHTTP(options); }
  async request(route, key, { body, signal } = {}) {
    const data = await this.http.request(`https://api.minimax.cn${route}`, { key, body, signal });
    if (data.error || data.base_resp?.status_code) {
      throw Error(`MiniMax：${redactVideoError(data.error?.message || data.base_resp?.status_msg, [key])}`);
    }
    return data;
  }
  async test(key) {
    const data = await this.request('/v2/query/video_generation?page_num=1&page_size=1', key);
    if (!Array.isArray(data?.items)) throw Error('MiniMax 返回无效任务列表');
    return { message: '连接成功' };
  }
  async create(key, { prompt, firstFrame, ...options }, signal) {
    const content = [{ type: 'text', text: prompt }];
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' });
    const data = await this.request('/v2/video_generation', key, { body: { ...options, ratio: firstFrame ? 'adaptive' : options.ratio, content }, signal });
    if (typeof data.task_id !== 'string' || !/^[\w-]{1,128}$/.test(data.task_id)) throw Error('MiniMax 未返回有效任务 ID；请到平台核对任务，勿自动重新提交');
    return data.task_id;
  }
  async query(key, id, signal) {
    if (!/^[\w-]{1,128}$/.test(id)) throw Error('无效的视频任务 ID');
    const { task } = await this.request(`/v2/query/video_generation/${encodeURIComponent(id)}`, key, { signal });
    if (!task || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(task.status)) throw Error('MiniMax 返回未知任务状态');
    return { status: task.status, url: task.content?.url,
      error: String(task.error?.message || '').split(key).join('[已隐藏]').slice(0, 400) };
  }
}
