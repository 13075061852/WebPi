export function initProxySettings({ root = document, api = window.halo } = {}) {
  const get = id => root.querySelector('#' + id);
  const form = get('proxyForm'), port = get('proxyPort');
  const apply = get('proxyApply'), reset = get('proxyReset'), result = get('proxyResult');
  const modeTabs = apply.parentElement;
  let revision = 0, busy = false;
  const storeStatus = get('proxyStoreStatus'), storeRepair = get('proxyStoreRepair'), storeResult = get('proxyStoreResult');
  let storeRevision = 0, storeBusy = false;
  function renderStore(state) {
    const supported = state.supported, installed = supported && state.installed;
    storeStatus.textContent = !supported ? '仅支持 Windows' : !installed ? '未安装商店' : state.enabled ? '已配置' : '未配置';
    storeStatus.dataset.state = installed && state.enabled ? 'enabled' : 'idle';
    storeRepair.textContent = installed && state.enabled ? '已配置' : '一键配置';
    storeRepair.disabled = !installed || state.enabled;
  }
  async function refreshStore() {
    if (!storeRepair || !api.proxyStoreStatus || storeBusy) return;
    const current = ++storeRevision;
    storeRepair.disabled = true;
    storeStatus.textContent = '检测中…';
    storeStatus.dataset.state = 'idle';
    storeResult.textContent = '';
    try {
      const reply = await api.proxyStoreStatus();
      if (current !== storeRevision || storeBusy) return;
      if (!reply?.ok) throw Error(reply?.error || '读取商店代理配置失败');
      renderStore(reply.data);
    } catch (error) {
      if (current !== storeRevision || storeBusy) return;
      storeStatus.textContent = '检测失败';
      storeRepair.textContent = '一键配置';
      storeRepair.disabled = false;
      storeResult.textContent = error.message;
    }
  }
  storeRepair?.addEventListener('click', async () => {
    if (storeBusy || storeRepair.disabled) return;
    storeBusy = true; storeRevision++;
    storeRepair.disabled = true;
    storeRepair.textContent = '配置中…';
    storeRepair.setAttribute('aria-busy', 'true');
    storeStatus.textContent = '等待系统授权';
    storeStatus.dataset.state = 'idle';
    storeResult.textContent = '';
    try {
      const reply = await api.proxyStoreRepair();
      if (!reply?.ok) throw Error(reply?.error || '配置失败，请重试');
      renderStore(reply.data);
      if (reply.data.enabled) storeResult.textContent = '请重新打开 Microsoft Store。';
    } catch (error) {
      storeStatus.textContent = '未配置';
      storeRepair.textContent = '一键配置';
      storeRepair.disabled = false;
      storeResult.textContent = error.message;
    } finally {
      storeBusy = false;
      storeRepair.removeAttribute('aria-busy');
    }
  });
  const test = get('connectivityTest'), results = get('connectivityResults');
  const doc = results.ownerDocument;
  let testing = false;
  let activeNetwork = 'foreign';
  const tested = new Set();
  const tabs = [...root.querySelectorAll('[data-network]')];
  const targets = { foreign: [['google', 'Google', 'www.google.com'], ['github', 'GitHub', 'github.com'],
    ['youtube', 'YouTube', 'www.youtube.com'], ['facebook', 'Facebook', 'www.facebook.com'],
    ['tiktok', 'TikTok', 'www.tiktok.com'], ['openai', 'OpenAI', 'openai.com'],
    ['anthropic', 'Anthropic', 'www.anthropic.com'], ['cloudflare', 'Cloudflare', 'www.cloudflare.com']],
  domestic: [['baidu', '百度', 'www.baidu.com'], ['bingcn', '必应', 'cn.bing.com'],
    ['qq', '腾讯', 'www.qq.com'], ['bilibili', '哔哩哔哩', 'www.bilibili.com'],
    ['taobao', '淘宝', 'www.taobao.com'], ['jd', '京东', 'www.jd.com']] };
  const groups = Object.fromEntries(Object.entries(targets).map(([network, entries]) => [network, entries.map(([id, name, domain]) => {
    const row = doc.createElement('div');
    row.className = 'connectivity-row';
    const label = doc.createElement('button'), title = doc.createElement('b'), address = doc.createElement('small');
    label.type = 'button'; label.className = 'connectivity-link';
    label.title = `在浏览器中打开 https://${domain}/`;
    label.addEventListener('click', async () => {
      try {
        const reply = await api.openExternal(`https://${domain}/`);
        if (!reply?.ok) throw Error('无法打开网站');
      } catch { result.textContent = `无法打开 ${name}，请稍后重试`; }
    });
    title.textContent = name; address.textContent = domain; label.append(title, address);
    const state = doc.createElement('span'); state.textContent = '未测试'; state.className = 'connectivity-state';
    row.append(label, state);
    return { id, state, row };
  })]));
  function selectNetwork(network) {
    activeNetwork = network;
    for (const tab of tabs) {
      const selected = tab.dataset.network === network;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) results.setAttribute('aria-labelledby', tab.id);
    }
    results.replaceChildren(...groups[network].map(item => item.row));
    test.textContent = tested.has(network) ? '重新测试' : '测试全部';
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectNetwork(tab.dataset.network));
    tab.addEventListener('keydown', event => {
      if (testing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + 1) % tabs.length];
      next.focus(); selectNetwork(next.dataset.network);
    });
  });
  selectNetwork(activeNetwork);
  test.addEventListener('click', async () => {
    if (testing || busy) return;
    testing = true;
    const rows = groups[activeNetwork];
    tabs.forEach(tab => { tab.disabled = true; });
    test.disabled = apply.disabled = reset.disabled = port.disabled = true;
    test.textContent = '测试中…';
    let completed = 0;
    await Promise.all(rows.map(async ({id, state}) => {
      state.textContent = '连接中…'; state.dataset.status = 'pending';
      try {
        const reply = await api.connectivityTest(id);
        if (!reply?.ok) throw Error(reply?.error || '测试失败');
        const data = reply.data;
        state.dataset.status = data.status;
        state.textContent = data.status === 'available' || data.status === 'connected'
          ? `网络已连通 · ${data.ms} ms` : data.error;
        state.title = '';
      } catch { state.dataset.status = 'failed'; state.textContent = '测试失败，请重试'; }
      test.textContent = `测试中 ${++completed}/${rows.length}`;
    }));
    testing = false;
    tested.add(activeNetwork);
    tabs.forEach(tab => { tab.disabled = false; });
    test.disabled = apply.disabled = reset.disabled = port.disabled = false;
    test.textContent = '重新测试';
  });
  const render = state => {
    port.value = state.port;
    const system = state.system;
    const enabled = system ? Boolean(system.flags & 2) : state.mode === 'proxy';
    const automatic = system && Boolean(system.flags & 12);
    const local = system?.server?.match(/^127\.0\.0\.1:(\d+)$/);
    if (enabled && local) port.value = local[1];
    modeTabs.dataset.mode = enabled || automatic ? 'proxy' : 'direct';
    apply.setAttribute('aria-pressed', String(enabled || Boolean(automatic)));
    reset.setAttribute('aria-pressed', String(!enabled && !automatic));
  };
  port.addEventListener('input', () => { revision++; });
  async function refreshProxy() {
    const current = ++revision;
    try {
      const reply = await api.proxyGet();
      if (current !== revision || busy) return;
      if (!reply?.ok) throw Error(reply?.error || '读取代理配置失败');
      render(reply.data);
    } catch (error) { result.textContent = error.message; }
  }
  async function save(mode) {
    if (busy || testing) return;
    busy = true; revision++;
    apply.disabled = reset.disabled = port.disabled = true;
    result.textContent = '';
    const pendingButton = mode === 'proxy' ? apply : reset;
    pendingButton.classList.add('is-switching');
    pendingButton.setAttribute('aria-busy', 'true');
    try {
      const reply = await api.proxySet({ mode, port:port.value });
      if (!reply?.ok) throw Error(reply?.error || '切换失败');
      render(reply.data);
      result.textContent = ''; 
    } catch (error) { result.textContent = error.message; }
    finally {
      pendingButton.classList.remove('is-switching');
      pendingButton.removeAttribute('aria-busy');
      busy = false; apply.disabled = reset.disabled = port.disabled = false;
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void save('proxy'); });
  reset.addEventListener('click', () => { void save('direct'); });
  return { refresh: () => Promise.all([refreshProxy(), refreshStore()]) };
}
