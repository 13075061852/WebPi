import { VideoHTTP } from './video-http.mjs';
import { validateVideoOptions, videoSpec, videoModelDefaults } from './video-providers.mjs';
import { validateVideoNetwork } from './video-settings.mjs';

const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const round = n => Number(n.toFixed(8));
const SOURCE = 'https://apimart.ai/pricing';
const perVideo = new Set(['veo3.1-fast', 'veo3.1-quality', 'veo3.1-lite']);

// /api/pricing/model exposes base rates, not final promotional rates. The official
// pricing page supplies fixed_prices.items with original_price AND after_discount.
// Read that data; never infer a discount from a bill or execute page JavaScript.
export function parseApimartPricing(html) {
  let flight = '';
  for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const marker = 'self.__next_f.push(', start = body.indexOf(marker);
    if (start < 0) continue;
    try {
      const frame = JSON.parse(body.slice(start + marker.length, body.lastIndexOf(')')));
      if (frame[0] === 1 && typeof frame[1] === 'string') flight += frame[1];
    } catch { /* Non-data scripts are intentionally ignored. */ }
  }
  const models = new Map();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 60) return;
    if (typeof value.id === 'string' && value.fixed_prices?.items) models.set(value.id, value);
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  for (const line of flight.split('\n')) {
    try { visit(JSON.parse(line.slice(line.indexOf(':') + 1))); } catch { /* Other Flight records are not JSON. */ }
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
    const response = await http.raw(SOURCE, { timeoutMs: 12000 });
    if (!response.ok) { await response.body?.cancel(); throw Error('报价获取失败'); }
    let size = 0, html = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw Error('报价响应过大');
      html += decoder.decode(chunk, { stream: true });
    }
    const models = parseApimartPricing(html + decoder.decode());
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
      const value = estimateApimart(data, { ...options, inputImageCount: input.inputImageCount ?? 0 });
      return value ? { available: true, ...value, source: SOURCE, updatedAt: entry.at, parameters: options }
        : { available: false, message: '当前参数暂无可靠折后报价', source: SOURCE };
    } catch {
      if (this.cache.get(network) === entry) this.cache.delete(network);
      return { available: false, message: '报价获取失败，请稍后重试', source: SOURCE };
    }
  }
}
