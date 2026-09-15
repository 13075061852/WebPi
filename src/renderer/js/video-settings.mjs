import { videoBalanceText } from './video-balance.mjs';
const KEY_HOSTS = {
  apimart: ['apimart.ai'],
  minimax: ['platform.minimax.cn', 'platform.minimaxi.com', 'platform.minimax.io'],
  xai: ['console.x.ai'],
  google: ['aistudio.google.com'],
  runway: ['dev.runwayml.com'],
  luma: ['platform.lumalabs.ai'],
  dashscope: ['bailian.console.aliyun.com'],
  volcengine: ['ark.volcengine.com'],
  kling: ['klingai.com'],
  vidu: ['platform.vidu.cn'],
};
const PROVIDER_LABELS = { dashscope: '通义万相', volcengine: '豆包 Seedance', kling: '可灵 Kling', vidu: 'Vidu' };

function keyLink(spec) {
  try {
    const url = new URL(spec.keyUrl);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && KEY_HOSTS[spec.id]?.includes(url.hostname)) return url.href;
  } catch {}
  return null;
}

export function initVideoSettings({ root = document, api = window.halo, onSaved = () => {} } = {}) {
  const get = id => root.querySelector(`#${id}`), form = get('videoSettingsForm');
  if (!form) return { refresh: async () => {} };
  const drafts = new Map();
  let state, selectedProvider, enabledDraft, busy = false;
  let balanceVersion = 0;
  async function refreshBalance() {
    const button = get('videoBalance');
    if (!button) return;
    const version = ++balanceVersion, provider = selectedProvider;
    const value = button.querySelector('.video-balance-value');
    value.textContent = '查询中…';
    try {
      const reply = await api.videoBalance({ provider });
      if (version !== balanceVersion || provider !== selectedProvider) return;
      value.textContent = videoBalanceText(reply?.ok ? reply.data : null);
      button.dataset.available = String(!!reply?.data?.available);
      button.title = reply?.ok ? '平台账户余额，点击刷新' : reply?.error || '查询失败，点击重试';
    } catch { if (version === balanceVersion) { value.textContent = '查询失败'; button.dataset.available = 'false'; } }
  }
  let estimateVersion = 0, estimateTimer;
  let modelPriceVersion = 0, modelPriceTimer;
  function updateModelPrices() {
    const version = ++modelPriceVersion;
    clearTimeout(modelPriceTimer);
    const select = get('videoModel');
    for (const option of select.options) option.textContent = option.value;
    if (selectedProvider !== 'apimart' || !api.videoModelPrices) return;
    modelPriceTimer = setTimeout(async () => {
      const { provider, resolution, network } = input();
      try {
        const reply = await api.videoModelPrices({ provider, resolution, network });
        if (version !== modelPriceVersion) return;
        const prices = new Map((reply?.ok ? reply.data : []).map(value => [value.model, value]));
        for (const option of select.options) {
          const quote = prices.get(option.value);
          const rate = quote?.available && quote.currency === 'Credits'
            ? `${Number(quote.rate.toFixed(6))} 积分/${quote.unit === 'second' ? '秒' : '条'}` : '暂无报价';
          option.textContent = `${option.value} · ${quote?.resolution || resolution} · ${rate}`;
        }
      } catch {
        if (version === modelPriceVersion) for (const option of select.options) option.textContent = `${option.value} · 暂无报价`;
      }
    }, 180);
  }
  function updateEstimate() {
    const version = ++estimateVersion;
    clearTimeout(estimateTimer);
    const price = get('videoEstimateValue'), detail = get('videoEstimateDetail');
    price.textContent = '获取报价中…'; detail.textContent = '';
    estimateTimer = setTimeout(async () => {
      const { provider, model, resolution, duration, ratio, network } = input();
      try {
        const reply = await api.videoEstimate({ provider, model, resolution, duration, ratio, network });
        if (version !== estimateVersion) return;
        if (!reply?.ok || !reply.data?.available) {
          price.textContent = reply?.data?.message || '报价暂不可用'; return;
        }
        const value = reply.data;
        const amount = n => Number(n.toFixed(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
        const formatted = n => value.currency === 'Credits' ? `${amount(n)} 积分` : `$${amount(n)}`;
        price.textContent = `≈ ${formatted(value.total)} / 条`;
        detail.textContent = value.unit === 'second'
          ? `${formatted(value.rate)} / 秒 × ${duration} 秒 · ${value.basis}`
          : `${value.basis} · 按条计费`;
      } catch { if (version === estimateVersion) price.textContent = '报价暂不可用'; }
    }, 180);
  }
  const feedback = (text, error = false) => {
    const result = get('videoSettingsResult'); result.textContent = text; result.hidden = !text; result.classList.toggle('error', error);
  };
  const specFor = provider => state?.providers.find(spec => spec.id === provider);
  const savedFor = provider => state?.configs?.[provider] || (state && state.provider === provider ? state : {});
  function options(id, items, selected, fallback) {
    const select = get(id);
    select.replaceChildren(...items.map(item => {
      const option = form.ownerDocument.createElement('option');
      option.value = String(typeof item === 'object' ? item.id : item);
      option.textContent = typeof item === 'object' ? item.name : String(item);
      return option;
    }));
    const values = [...select.options].map(option => option.value);
    select.value = values.includes(String(selected)) ? String(selected)
      : values.includes(String(fallback)) ? String(fallback) : values[0] || '';
  }
  function input(provider = selectedProvider) {
    return { provider, model: get('videoModel').value, resolution: get('videoResolution').value,
      duration: Number(get('videoDuration').value), ratio: get('videoRatio').value, network: get('videoNetwork').value,
      apiKey: get('videoApiKey').value };
  }
  function remember() {
    if (selectedProvider) drafts.set(selectedProvider, input());
  }
  function renderProviders() {
    get('videoProviders').replaceChildren(...state.providers.map(spec => {
      const button = form.ownerDocument.createElement('button');
      button.type = 'button'; button.className = 'model-provider'; button.dataset.provider = spec.id; button.title = spec.name;
      const name = form.ownerDocument.createElement('span');
      name.textContent = PROVIDER_LABELS[spec.id] || spec.name;
      button.appendChild(name);
      if (spec.id === state.provider) {
        button.classList.add('is-default');
        button.title = `${spec.name} · 默认模型：${state.defaultModel}`;
        const badge = form.ownerDocument.createElement('span');
        badge.className = 'video-default-badge'; badge.textContent = '默认';
        button.appendChild(badge);
      }
      return button;
    }));
  }
  function durations(spec, rules, resolution) {
    const allowed = rules.durationsByResolution?.[resolution] || rules.durations || spec.durations;
    if (allowed) return allowed;
    const min = rules.minDuration ?? spec.minDuration ?? spec.defaults.duration;
    const max = rules.maxDuration ?? spec.maxDuration ?? min;
    return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }
  function updateModelOptions(values = input()) {
    const spec = specFor(selectedProvider), rules = spec.modelOptions?.[get('videoModel').value] || spec;
    options('videoResolution', rules.resolutions || spec.resolutions, values.resolution, spec.defaults.resolution);
    options('videoRatio', (rules.ratios || spec.ratios).map(ratio => ({ id: ratio, name: ratio === 'adaptive' ? '自适应' : ratio })), values.ratio, spec.defaults.ratio);
    options('videoDuration', durations(spec, rules, get('videoResolution').value).map(seconds => ({ id: seconds, name: `${seconds} 秒` })), values.duration, spec.defaults.duration);
  }
  function updateControls() {
    form.querySelectorAll('input, select, button').forEach(node => { node.disabled = busy; });
    get('videoProviders').querySelectorAll('button').forEach(node => { node.disabled = busy; });
    get('videoTest').disabled = busy || (!savedFor(selectedProvider).hasApiKey && !get('videoApiKey').value.trim());
  }
  function showProvider(provider) {
    selectedProvider = provider;
    const spec = specFor(provider), saved = savedFor(provider);
    const values = { ...spec.defaults, network: 'system', ...saved, ...drafts.get(provider) };
    get('videoProviders').querySelectorAll('button').forEach(button => {
      const selected = button.dataset.provider === provider;
      button.classList.toggle('on', selected); button.setAttribute('aria-pressed', String(selected));
    });
    get('videoProviderName').textContent = spec.name;
    options('videoModel', spec.models, values.model, spec.defaults.model);
    updateModelOptions(values);
    get('videoNetwork').value = ['system', 'direct', 'proxy'].includes(values.network) ? values.network : 'system';
    // A password draft belongs only to the provider that received the input.
    get('videoApiKey').value = drafts.get(provider)?.apiKey || '';
    get('videoApiKey').placeholder = saved.hasApiKey ? '已保存，输入可替换' : 'API Key';
    get('videoKeyStatus').textContent = saved.hasApiKey ? '已配置' : '未配置';
    get('videoKeyStatus').classList.toggle('ready', !!saved.hasApiKey);
    void refreshBalance();
    get('videoClearKey').hidden = !saved.hasApiKey;
    const link = get('videoKeyLink'), url = keyLink(spec);
    link.hidden = !url;
    if (url) link.href = url; else link.removeAttribute('href');
    updateControls();
    updateEstimate();
    updateModelPrices();
  }
  function apply(value, provider = selectedProvider || value.provider) {
    state = value;
    if (!specFor(provider)) provider = state.provider;
    renderProviders();
    get('videoEnabled').checked = enabledDraft ?? state.enabled;
    showProvider(provider);
  }
  async function run(action) {
    if (busy) return;
    busy = true; feedback('');
    form.setAttribute('aria-busy', 'true'); updateControls();
    try { await action(); }
    catch (error) { feedback(error?.message || '操作失败', true); }
    finally {
      busy = false; form.setAttribute('aria-busy', 'false'); updateControls();
    }
  }
  async function result(promise) {
    const reply = await promise;
    if (!reply?.ok) throw Error(reply?.error || '操作失败');
    return reply.data;
  }
  function save(setDefault = false) {
    void run(async () => {
      const values = { ...input(), enabled: get('videoEnabled').checked, setDefault };
      const value = await result(api.videoSave(values));
      drafts.delete(values.provider); enabledDraft = undefined;
      apply(value, values.provider); feedback('');
      onSaved();
    });
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); save(true);
  });
  get('videoClearKey').addEventListener('click', () => { void run(async () => {
    const provider = selectedProvider;
    remember();
    const value = await result(api.videoSave({ provider, clearKey: true }));
    drafts.get(provider).apiKey = '';
      apply(value, provider); feedback('密钥已移除');
      onSaved();
  }); });
  get('videoTest').addEventListener('click', () => { void run(async () => {
    if (get('videoApiKey').value.trim()) throw Error('请先保存新的 API Key');
    if (!savedFor(selectedProvider).hasApiKey) throw Error('请先保存 API Key');
    feedback('连接中…');
    const data = await result(api.videoTest({ provider: selectedProvider, network: get('videoNetwork').value }));
    feedback(data.message);
  }); });
  get('videoKeyLink').addEventListener('click', event => {
    event.preventDefault();
    const url = keyLink(specFor(selectedProvider));
    if (url) void result(api.openExternal(url)).catch(error => feedback(error.message || '无法打开链接', true));
  });
  get('videoProviders').addEventListener('click', event => {
    const button = event.target.closest('button[data-provider]');
    const provider = button?.dataset.provider;
    if (busy || !specFor(provider) || provider === selectedProvider) return;
    remember(); showProvider(provider); form.scrollTop = 0; feedback('');
    if (savedFor(provider).hasApiKey || get('videoApiKey').value.trim()) save(true);
  });
  get('videoModel').addEventListener('change', () => {
    updateModelOptions(); remember(); updateControls(); feedback('');
    if (savedFor(selectedProvider).hasApiKey || get('videoApiKey').value.trim()) save(true);
  });
  get('videoResolution').addEventListener('change', () => { updateModelOptions(); remember(); feedback(''); });
  get('videoApiKey').addEventListener('input', () => { remember(); updateControls(); feedback(''); });
  get('videoEnabled').addEventListener('change', () => { enabledDraft = get('videoEnabled').checked; });
  get('videoBalance')?.addEventListener('click', () => void refreshBalance());
  for (const id of ['videoModel', 'videoResolution', 'videoNetwork']) get(id).addEventListener('change', updateModelPrices);
  for (const id of ['videoModel', 'videoResolution', 'videoDuration', 'videoRatio', 'videoNetwork']) {
    get(id).addEventListener('change', updateEstimate);
  }
  return { refresh: () => run(async () => { remember(); apply(await result(api.videoSettings())); }) };
}
