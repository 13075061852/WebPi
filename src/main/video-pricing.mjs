import { VideoHTTP } from './video-http.mjs';
import { validateVideoOptions, videoSpec, videoModelDefaults } from './video-providers.mjs';
import { validateVideoNetwork } from './video-settings.mjs';

const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const round = n => Number(n.toFixed(8));
const SOURCE = 'https://apimart.ai/pricing';
const CATALOG = 'https://apimart.ai/api/pricing/models/all';
const perVideo = new Set(['veo3.1-fast', 'veo3.1-quality', 'veo3.1-lite']);

// The pricing page loads this public catalog client-side. Its after_discount
// values are the displayed rates; the older per-model API supplies base rates.
export function parseApimartPricing(data) {
  const models = new Map();
  if (data?.success !== true || !Array.isArray(data.data?.models?.video)) return models;
  for (const value of data.data.models.video) {
    if (typeof value?.id === 'string' && Array.isArray(value.fixed_prices?.items)) models.set(value.id, value);
  }
  return models;
}

export function estimateApimart(data, options) {
  const { model, resolution, duration, inputImageCount = 0 } = options;
  if (data?.id !== model || !finite(inputImageCount) || !Number.isInteger(inputImageCount)) return null;
  const table = data.fixed_prices;
  const unit = table?.unit === 'usd_per_second' ? 'second' : table?.unit === 'usd_per_call' ? 'video' : null;
  if (!unit || table.dimension !== 'resolution' || !Array.isArray(table.items)) return null;
  let tier = resolution;
  if (model === 'kling-v3') tier = { '720P': 'default', '1080P': 'pro', '4K': '4k' }[resolution];
  if (model.startsWith('sora-')) tier = `official-${resolution}`;
  let item = table.items.find(item => item.key === tier);
  if (!item && ((perVideo.has(model) && ['720P', '1080P'].includes(resolution)) || (model === 'wan2.6' && resolution === '720P'))) {
    item = table.items.find(item => item.key === 'default');
  }
  if (!finite(item?.after_discount)) return null;
  const rate = round(item.after_discount * 10);
  let materialTotal = 0;
  const image = data.input_material_prices?.image;
  if (inputImageCount && image) {
    if (image.unit !== 'usd_per_image' || !finite(image.free_count) || !finite(image.after_discount)) return null;
    materialTotal = round(Math.max(0, inputImageCount - image.free_count) * image.after_discount * 10);
  }
  return { currency: 'Credits', unit, rate, total: round(rate * (unit === 'second' ? duration : 1) + materialTotal),
    basis: data.token_settlement_prices ? '平台折后预估，最终按 Token 结算' : '平台折后报价',
    pricing: { tier: item.key, originalRateUsd: finite(item.original_price) ? item.original_price : null,
      effectiveRateUsd: item.after_discount, creditsPerUsd: 10, materialTotal, inputImageCount,
      settlement: data.token_settlement_prices ? 'tokens' : unit },
  };
}

export class VideoPricing {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) { this.fetchImpl = fetchImpl; this.now = now; this.cache = new Map(); }
  async models(input) {
    const spec = videoSpec(input?.provider), network = validateVideoNetwork(input.network);
    if (spec.id !== 'apimart') return [];
    return Promise.all(spec.models.map(async model => {
      const options = videoModelDefaults(spec.id, model), rules = spec.modelOptions[model];
      if (rules.resolutions.includes(input.resolution)) options.resolution = input.resolution;
      const allowed = rules.durationsByResolution?.[options.resolution];
      if (allowed && !allowed.includes(options.duration)) options.duration = allowed[0];
      return { model, resolution: options.resolution, ...await this.estimate({ provider: spec.id, network, ...options }) };
    }));
  }
  async load(network) {
    const http = new VideoHTTP({ fetchImpl: this.fetchImpl, network });
    const data = await http.request(CATALOG, { timeoutMs: 12000, headers: { Accept: 'application/json' } });
    const models = parseApimartPricing(data);
    if (!models.size) throw Error('平台报价格式已变化');
    return models;
  }
  async estimate(input) {
    const spec = videoSpec(input?.provider), options = validateVideoOptions(spec.id, input);
    const network = validateVideoNetwork(input.network);
    if (spec.id !== 'apimart') return { available: false, message: '暂无可靠报价', source: spec.docsUrl };
    let entry = this.cache.get(network);
    if (!entry || this.now() - entry.at >= 300000) {
      entry = { at: this.now(), promise: this.load(network) }; this.cache.set(network, entry);
    }
    try {
      const data = (await entry.promise).get(options.model);
      if (!data) return { available: false, message: '平台暂未提供该模型报价', source: SOURCE };
      const value = estimateApimart(data, { ...options, inputImageCount: input.inputImageCount ?? 0 });
      return value ? { available: true, ...value, source: SOURCE, updatedAt: entry.at, parameters: options }
        : { available: false, message: '当前参数暂无可靠折后报价', source: SOURCE };
    } catch (error) {
      if (this.cache.get(network) === entry) this.cache.delete(network);
      return { available: false, message: '报价获取失败，请稍后重试', detail: error.message, source: SOURCE };
    }
  }
}
