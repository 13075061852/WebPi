export function mountVideoConfirmation(card, request, api = window.halo) {
  const existing = card.querySelector('.video-confirmation');
  if (existing?.dataset.id === request.id) return;
  existing?.remove();
  const doc = card.ownerDocument, panel = doc.createElement('form');
  panel.className = 'video-confirmation'; panel.dataset.id = request.id;
  panel.innerHTML = `<div class="video-confirm-heading">生成视频<span>等待确认</span></div>
    <p class="video-confirm-prompt"></p><div class="video-confirm-fields"></div>
    <p class="video-confirm-cost" aria-live="polite"></p>
    <p class="video-confirm-error" role="alert" hidden></p>
    <div class="video-confirm-actions"><button type="button" class="video-confirm-cancel">取消生成</button><button type="submit" class="video-confirm-submit">确认生成</button></div>`;
  panel.querySelector('.video-confirm-prompt').textContent = request.prompt;
  panel.querySelector('.video-confirm-heading').firstChild.textContent = `${request.providerName} · 生成视频`;
  const selects = {};
  for (const [key, title] of [['model','模型'],['duration','时长'],['resolution','分辨率'],['ratio','画面比例']]) {
    const label = doc.createElement('label'); label.textContent = title;
    const select = doc.createElement('select'); select.name = key; selects[key] = select;
    label.append(select); panel.querySelector('.video-confirm-fields').append(label);
  }
  function fill(key, values, value) {
    const select = selects[key];
    select.replaceChildren(...values.map(item => {
      const option = doc.createElement('option'); option.value = String(item);
      option.textContent = key === 'duration' ? `${item} 秒` : String(item); return option;
    }));
    select.value = values.map(String).includes(String(value)) ? String(value) : String(values[0] ?? '');
  }
  const models = Object.entries(request.modelOptions).filter(([, rules]) => request.firstFrame ? rules.supportsFirstFrame : !rules.requiresFirstFrame).map(([model]) => model);
  fill('model', models, request.model);
  function updateFields(initial = false) {
    const rules = request.modelOptions[selects.model.value];
    if (!rules) return;
    fill('resolution', rules.resolutions, initial ? request.resolution : selects.resolution.value);
    fill('ratio', rules.ratios, initial ? request.ratio : selects.ratio.value);
    const durations = rules.durationsByResolution?.[selects.resolution.value] || rules.durations
      || Array.from({ length: rules.maxDuration - rules.minDuration + 1 }, (_, i) => rules.minDuration + i);
    fill('duration', durations, initial ? request.duration : selects.duration.value);
  }
  const input = () => ({ model: selects.model.value, duration: Number(selects.duration.value), resolution: selects.resolution.value, ratio: selects.ratio.value });
  let version = 0, timer, busy = false;
  const cost = panel.querySelector('.video-confirm-cost');
  const showQuote = quote => { cost.textContent = quote?.available && Number.isFinite(quote.total)
    ? `预估消耗 ≈ ${Number(quote.total.toFixed(4))} ${quote.currency === 'Credits' ? '积分' : quote.currency} · 以平台实际计费为准`
    : '预估消耗暂不可用 · 以平台实际计费为准'; };
  function estimate() {
    const seq = ++version; clearTimeout(timer); cost.textContent = '正在计算预估消耗…';
    timer = setTimeout(async () => {
      try {
        const reply = await api.videoEstimate({ provider: request.provider, network: request.network, ...input(), inputImageCount: request.firstFrame ? 1 : 0 });
        if (seq === version && panel.isConnected) showQuote(reply?.ok ? reply.data : null);
      } catch { if (seq === version && panel.isConnected) showQuote(null); }
    }, 200);
  }
  panel.addEventListener('change', event => {
    if (['model','resolution'].includes(event.target.name)) updateFields();
    estimate();
  });
  async function respond(approved) {
    if (busy) return;
    busy = true; clearTimeout(timer); ++version;
    const error = panel.querySelector('.video-confirm-error'); error.hidden = true;
    for (const control of panel.querySelectorAll('button, select')) control.disabled = true;
    try {
      const reply = await api.videoConfirm({ id: request.id, approved, options: input() });
      if (!reply?.ok) throw Error(reply?.error || '提交失败，请重试');
      panel.querySelector('.video-confirm-heading span').textContent = approved ? '已确认' : '已取消';
      panel.querySelector('.video-confirm-actions').hidden = true;
    } catch (err) {
      busy = false; error.textContent = err.message; error.hidden = false;
      for (const control of panel.querySelectorAll('button, select')) control.disabled = false;
    }
  }
  panel.addEventListener('submit', event => { event.preventDefault(); void respond(true); });
  panel.querySelector('.video-confirm-cancel').addEventListener('click', () => void respond(false));
  updateFields(true); showQuote(request.estimate); card.append(panel);
}
