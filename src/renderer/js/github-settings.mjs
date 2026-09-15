export function initGitHubSettings({ root = document, api = window.halo } = {}) {
  const get = id => root.querySelector(`#${id}`);
  if (!get('githubAccounts')) return { refresh: async () => {} };
  let busy = false, seq = 0;
  function render(state) {
    get('githubAuthStatus').textContent = state.accounts?.length ? '已授权' : '未授权';
    get('githubAuthStatus').classList.toggle('ready', !!state.accounts?.length);
    get('githubSettings').dataset.state = state.accounts?.length ? 'ready' : 'unknown';
    const list = get('githubAccounts'); list.replaceChildren();
    for (const account of state.accounts || []) {
      const row = document.createElement('div'); row.className = 'github-account';
      const name = document.createElement('strong'); name.textContent = account;
      const view = document.createElement('button'); view.type = 'button'; view.className = 'mini-btn'; view.textContent = '查看仓库 ↗';
      view.addEventListener('click', () => void api.openExternal(`https://github.com/${encodeURIComponent(account)}?tab=repositories`));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mini-btn'; remove.textContent = '退出授权';
      remove.addEventListener('click', () => void run(() => api.githubLogout(account), '正在退出授权…'));
      row.append(name, view, remove); list.append(row);
    }
    get('githubAuthMessage').textContent = state.error || '';
  }
  function controls() {
    get('githubSettings').querySelectorAll('button').forEach(button => { button.disabled = busy; });
    get('githubAuthorize').textContent = busy ? '处理中…' : '授权';
  }
  async function refresh() {
    if (busy || !api.githubStatus) return;
    const request = ++seq;
    const reply = await api.githubStatus();
    if (request !== seq || busy) return;
    if (reply?.ok) render(reply.data);
  }
  async function run(action, message = '请在浏览器中完成 GitHub 授权') {
    if (busy) return;
    busy = true; seq++; controls();
    get('githubAuthMessage').textContent = message;
    try {
      const reply = await action();
      if (!reply?.ok) throw Error(reply?.error || '授权失败');
      render(reply.data);
    } catch (error) { get('githubAuthMessage').textContent = error.message; }
    finally { busy = false; controls(); }
  }
  get('githubAuthorize').addEventListener('click', () => void run(() => api.githubLogin()));
  void refresh();
  return { refresh };
}
