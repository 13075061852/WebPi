export function initCloudflareSettings({ root = document, api = window.halo } = {}) {
  const get = id => root.querySelector(`#${id}`);
  if (!get('cloudflareSettings')) return { refresh: async () => {} };
  let busy = false, sequence = 0;
  function render(state) {
    get('cloudflareSettings').dataset.state = state.authorized ? 'ready' : 'unknown';
    get('cloudflareAuthStatus').textContent = state.authorized ? '已授权' : '未授权';
    get('cloudflareAccount').textContent = state.email || state.accounts?.map(item => item.name).join('、') || 'Cloudflare Workers';
    get('cloudflareLogout').hidden = !state.authorized;
    get('cloudflareMessage').textContent = '';
  }
  async function refresh() {
    if (busy || !api.cloudflareStatus) return;
    const request = ++sequence;
    try {
      const reply = await api.cloudflareStatus();
      if (request !== sequence || busy) return;
      if (!reply?.ok) throw Error(reply?.error || '授权查询失败');
      render(reply.data);
    } catch (error) { if (request === sequence) get('cloudflareMessage').textContent = error.message; }
  }
  async function auth(login) {
    if (busy) return;
    busy = true; sequence++;
    get('cloudflareSettings').querySelectorAll('button').forEach(button => { button.disabled = true; });
    get('cloudflareMessage').textContent = login ? '请在浏览器中完成授权…' : '正在退出授权…';
    try {
      const reply = await (login ? api.cloudflareLogin() : api.cloudflareLogout());
      if (!reply?.ok) throw Error(reply?.error || '授权操作失败');
      render(reply.data);
    } catch (error) { get('cloudflareMessage').textContent = error.message; }
    finally { busy = false; get('cloudflareSettings').querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  }
  get('cloudflareAuthorize').addEventListener('click', () => void auth(true));
  get('cloudflareLogout').addEventListener('click', () => void auth(false));
  get('cloudflareDashboard').addEventListener('click', () => void api.openExternal('https://dash.cloudflare.com/'));
  void refresh();
  return { refresh };
}
