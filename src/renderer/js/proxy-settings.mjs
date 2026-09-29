export function initProxySettings({ root = document, api = window.halo } = {}) {
  const get = id => root.querySelector('#' + id);
  const form = get('proxyForm'), port = get('proxyPort'), status = get('proxyStatus');
  const apply = get('proxyApply'), reset = get('proxyReset'), result = get('proxyResult');
  let revision = 0, busy = false;
  const render = state => {
    port.value = state.port;
    const system = state.system;
    const enabled = system ? Boolean(system.flags & 2) : state.mode === 'proxy';
    const automatic = system && Boolean(system.flags & 12);
    status.textContent = enabled ? `已启用${automatic ? ' · 自动配置' : ''}` : automatic ? '自动代理' : '直连';
    const local = system?.server?.match(/^127\.0\.0\.1:(\d+)$/);
    if (enabled && local) port.value = local[1];
    status.dataset.mode = enabled || automatic ? 'proxy' : 'direct';
    apply.textContent = enabled ? '应用' : '启用代理';
  };
  port.addEventListener('input', () => { revision++; });
  async function refresh() {
    const current = ++revision;
    try {
      const reply = await api.proxyGet();
      if (current !== revision || busy) return;
      if (!reply?.ok) throw Error(reply?.error || '读取代理配置失败');
      render(reply.data);
    } catch (error) { result.textContent = error.message; }
  }
  async function save(mode) {
    if (busy) return;
    busy = true; revision++;
    apply.disabled = reset.disabled = port.disabled = true;
    result.textContent = '正在切换…';
    try {
      const reply = await api.proxySet({ mode, port:port.value });
      if (!reply?.ok) throw Error(reply?.error || '切换失败');
      render(reply.data);
      result.textContent = ''; 
    } catch (error) { result.textContent = error.message; }
    finally { busy = false; apply.disabled = reset.disabled = port.disabled = false; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void save('proxy'); });
  reset.addEventListener('click', () => { void save('direct'); });
  return { refresh };
}
