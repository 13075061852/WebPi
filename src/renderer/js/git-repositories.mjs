// Repository operations are explicit; choosing an account or a repository only reads state.
function defaultSelectedFile(path) {
  const parts = String(path).replaceAll('\\', '/').toLocaleLowerCase().split('/');
  const filename = parts.at(-1);
  return !parts.some(part => ['node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__'].includes(part)) &&
    !(/^\.env(?:\.|$)/.test(filename) && !/^\.env\.(?:example|sample|template)$/.test(filename)) &&
    !/\.(?:pem|key|p12|pfx)$/.test(filename) &&
    !/^(?:auth|credentials?|secrets?)\.json$/.test(filename);
}

export function initGitRepositories({ root = document, api = window.halo, onOpenProject, onClone, onChanged, renderLocalProjects, modalMotion } = {}) {
  const get = id => root.querySelector(`#${id}`);
  const pane = root.querySelector('[data-pane="git"]');
  if (!pane) return { refresh: async () => {}, activate: async () => {}, updateProjects: () => {}, destroy: () => {} };
  const doc = pane.ownerDocument;
  const elements = { browse: get('gitBrowse'), create: get('gitCreate'), message: get('gitRepositoryMessage'), list: get('gitRepositoryList') };
  let account = '', accounts = [], repositories = [], loading = false, authenticating = false, mutating = false;
  let localRepositories = [], localSeq = 0, localLoading = false;
  let listSeq = 0, authSeq = 0, dialogSeq = 0, selected = null, status = null, alive = true, refreshPending = null;
  let view = 'closed', origin = 'local', loadedAccount = '';
  const listeners = [];
  const listen = (element, event, action) => { element.addEventListener(event, action); listeners.push(() => element.removeEventListener(event, action)); };
  const node = (tag, className, text) => {
    const result = doc.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const button = (id, text, action, className = 'mini-btn') => {
    const result = node('button', className, text); result.type = 'button'; result.id = id;
    result.addEventListener('click', action); return result;
  };
  const icon = (paths, className = 'ic') => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', className); svg.setAttribute('aria-hidden', 'true');
    for (const value of paths) { const child = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); child.setAttribute('d', value); svg.append(child); }
    return svg;
  };
  const remote = { account: node('div', 'git-account-info'),
    search: node('input'), message: node('p', 'git-message'), list: node('div', 'git-remote-repository-list'),
    create: button('gitRemoteCreate', '新建仓库', createRepository), toolbar: node('div', 'git-account-row git-picker-toolbar') };
  remote.account.id = 'gitAccount'; remote.account.setAttribute('aria-label', 'GitHub 账号');
  remote.search.id = 'gitSearch'; remote.search.type = 'search'; remote.search.placeholder = '搜索仓库…'; remote.search.autocomplete = 'off'; remote.search.setAttribute('aria-label', '搜索 GitHub 仓库');
  remote.message.id = 'gitRemoteRepositoryMessage'; remote.message.classList.add('git-picker-status'); remote.message.setAttribute('role', 'status'); remote.message.setAttribute('aria-live', 'polite');
  remote.list.id = 'gitRemoteRepositoryList'; remote.list.setAttribute('aria-label', '远程 GitHub 仓库');
  const searchShell = node('div', 'git-picker-search-field');
  searchShell.append(icon(['M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15', 'm16 16 5 5']), remote.search);
  remote.toolbar.append(searchShell, remote.create);
  async function call(method, values) {
    if (typeof api[method] !== 'function') throw Error('当前版本不支持仓库管理');
    const reply = await api[method](values);
    if (!reply?.ok) throw Error(reply?.error || '操作失败，请重试');
    return reply.data;
  }
  function message(text = '', error = false) {
    remote.message.textContent = text; remote.message.title = text; remote.message.classList.toggle('error', error);
    remote.message.hidden = !text;
  }
  function controls() {
    remote.create.disabled = !account || authenticating || mutating;
    elements.create.disabled = authenticating || mutating;
    elements.browse.disabled = authenticating || mutating;
    remote.list.setAttribute('aria-busy', String(loading));
    elements.list.setAttribute('aria-busy', String(localLoading));
  }
  function renderAccounts() {
    remote.account.textContent = account || '未登录';
    remote.account.title = account ? `GitHub · ${account}` : '未登录 GitHub';
    controls();
  }
  function renderRepositories() {
    const query = remote.search.value.trim().toLocaleLowerCase();
    const filtered = repositories.filter(repo => `${repo.fullName} ${repo.description || ''}`.toLocaleLowerCase().includes(query));
    remote.list.replaceChildren();
    for (const repo of filtered) {
      const row = button('', '', () => void openRepository(repo), 'git-repo-row');
      row.removeAttribute('id'); row.dataset.repository = repo.fullName; row.title = repo.description ? `${repo.fullName}\n${repo.description}` : repo.fullName;
      const heading = node('span', 'git-repo-heading');
      heading.append(node('strong', 'git-repo-name', repo.name || repo.fullName.split('/').at(-1)), node('span', 'git-repo-visibility', repo.private ? '私有' : '公开'));
      const owner = repo.fullName.includes('/') ? repo.fullName.slice(0, repo.fullName.lastIndexOf('/')) : '';
      const content = node('span', 'git-repo-content'); content.append(heading);
      const secondary = node('span', 'git-repo-secondary');
      if (owner && owner.toLocaleLowerCase() !== account.toLocaleLowerCase()) secondary.append(node('span', 'git-repo-owner', owner));
      if (repo.description) secondary.append(node('span', 'git-repo-description', repo.description));
      if (secondary.childNodes.length) content.append(secondary);
      const trailing = node('span', 'git-repo-trailing');
      if (repo.localPath) trailing.append(node('span', 'git-repo-local', '已克隆'));
      else trailing.append(icon(['m9 5 7 7-7 7'], 'ic git-repo-arrow'));
      row.append(icon(['M5 3h13a1 1 0 0 1 1 1v16H7a3 3 0 0 1-3-3V5a2 2 0 0 1 1-2', 'M4 17a3 3 0 0 1 3-3h12M8 3v11'], 'ic git-repo-icon'), content, trailing);
      remote.list.append(row);
    }
    if (!filtered.length && !loading) remote.list.append(node('p', 'git-repo-empty', !account ? '请在设置的环境配置中登录 GitHub' : query ? '没有匹配的仓库' : '暂无可访问的仓库'));
  }
  function updateProjects() {
    if (!alive) return;
    if (renderLocalProjects) {
      const failed = error => { if (alive) { elements.message.textContent = error.message; elements.message.classList.add('error'); } };
      try {
        const result = renderLocalProjects(elements.list, localRepositories, repo => void openRepository(repo, { from: 'local' }));
        Promise.resolve(result).catch(failed);
      } catch (error) { failed(error); }
      return;
    }
    elements.list.replaceChildren();
    for (const repo of localRepositories) {
      const row = node('div', 'git-local-row'); row.dataset.repository = repo.fullName;
      const open = button('', repo.name || repo.fullName, async () => {
        try { await onOpenProject?.(repo.localPath); }
        catch (error) { elements.message.textContent = error.message; elements.message.classList.add('error'); }
      }, 'git-local-open'); open.removeAttribute('id'); open.title = repo.localPath;
      const manage = button('', '⋯', () => void openRepository(repo, { from: 'local' }), 'mini-btn'); manage.removeAttribute('id'); manage.setAttribute('aria-label', `管理 ${repo.fullName}`);
      row.append(open, manage); elements.list.append(row);
    }
    if (!localRepositories.length && !localLoading) elements.list.append(node('p', 'git-repo-empty', '尚未克隆仓库'));
  }
  async function loadLocalRepositories() {
    const request = ++localSeq; localLoading = true; controls();
    try {
      const result = await call('gitLocalRepositories');
      if (!alive || request !== localSeq) return;
      localRepositories = result.repositories || [];
      elements.message.textContent = ''; elements.message.classList.remove('error');
    } catch (error) {
      if (alive && request === localSeq) { elements.message.textContent = error.message; elements.message.classList.add('error'); }
    } finally {
      if (alive && request === localSeq) { localLoading = false; controls(); updateProjects(); }
    }
  }
  async function loadRepositories({ force = false } = {}) {
    const request = ++listSeq, requestedAccount = account;
    repositories = []; loading = !!requestedAccount;
    renderRepositories(); controls();
    if (!requestedAccount) { message(); return; }
    message('正在获取仓库…');
    try {
      const result = await call('gitRepositories', { account: requestedAccount, force });
      if (!alive || request !== listSeq || requestedAccount !== account || view !== 'picker') return;
      repositories = result.repositories || [];
      loadedAccount = requestedAccount;
      message();
    } catch (error) {
      if (alive && request === listSeq) message(error.message, true);
    } finally {
      if (alive && request === listSeq) { loading = false; controls(); renderRepositories(); }
    }
  }
  async function refreshState({ force = false } = {}) {
    if (authenticating || mutating) return;
    const request = ++authSeq;
    try {
      const result = await call('githubStatus');
      if (!alive || request !== authSeq || view !== 'picker') return;
      accounts = result.accounts || [];
      account = accounts.includes(result.selectedAccount) ? result.selectedAccount : accounts.includes(account) ? account : accounts[0] || '';
      renderAccounts();
      await loadRepositories({ force });
    } catch (error) { if (alive && request === authSeq) message(error.message, true); }
  }
  function refreshRemote(options = {}) {
    if (refreshPending) return refreshPending;
    const pending = refreshState(options).finally(() => { if (refreshPending === pending) refreshPending = null; });
    refreshPending = pending;
    return pending;
  }
  const dialog = node('dialog', 'modal git-dialog'); dialog.id = 'gitRepositoryDialog'; dialog.hidden = true;
  const panel = node('section', 'modal-panel git-repository-panel');
  const header = node('header', 'modal-head');
  const title = node('h3'); title.id = 'gitRepoTitle';
  const close = button('gitRepoClose', '×', closeDialog, 'modal-x'); close.setAttribute('aria-label', '关闭仓库管理');
  const heading = node('div', 'git-dialog-heading');
  const back = button('gitRepoPickerBack', '', () => void openPicker({ refresh: false }), 'git-heading-back');
  back.append(icon(['m14 6-6 6 6 6']));
  back.title = '返回仓库列表'; back.setAttribute('aria-label', '返回仓库列表'); back.hidden = true;
  heading.append(back, title);
  header.append(heading, close);
  const body = node('div', 'git-dialog-body');
  const feedback = node('p', 'git-dialog-feedback'); feedback.id = 'gitRepoMessage'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  panel.append(header, body, feedback); dialog.append(panel); dialog.setAttribute('aria-labelledby', title.id);
  doc.body.append(dialog);
  function openDialog() {
    if (dialog.open) return;
    if (modalMotion) modalMotion.open(dialog);
    else { dialog.hidden = false; dialog.classList.add('show'); dialog.showModal(); }
  }
  function closeDialog() {
    if (mutating) return;
    dialogSeq++; authSeq++; listSeq++; loading = false; view = 'closed'; selected = null; status = null;
    if (modalMotion) modalMotion.close(dialog);
    else { dialog.close(); dialog.hidden = true; dialog.classList.remove('show'); }
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
  function placeDialogFeedback() {
    const footer = body.querySelector('.git-commit-footer');
    if (footer) body.insertBefore(feedback, footer);
    else panel.append(feedback);
  }
  function dialogMessage(text = '', error = false) { feedback.textContent = text; feedback.classList.toggle('error', error); placeDialogFeedback(); }
  function renderPicker() {
    view = 'picker'; origin = 'picker'; selected = null; status = null;
    dialog.dataset.view = 'picker';
    back.hidden = true;
    title.textContent = '克隆 GitHub 仓库';
    heading.append(remote.account);
    body.replaceChildren(remote.toolbar, remote.message, remote.list);
    dialogMessage(); renderAccounts(); renderRepositories();
  }
  async function openPicker({ create = false, refresh = true } = {}) {
    if (mutating || authenticating) return;
    dialogSeq++; authSeq++; listSeq++; refreshPending = null;
    if (create) {
      const request = dialogSeq;
      view = 'create-loading'; dialog.dataset.view = 'create';
      back.hidden = false;
      title.textContent = '新建 GitHub 仓库';
      body.replaceChildren(node('p', 'git-loading', '正在读取账号…')); dialogMessage();
      try {
        const result = await call('githubStatus');
        if (!alive || request !== dialogSeq || view !== 'create-loading') return;
        accounts = result.accounts || [];
        account = accounts.includes(result.selectedAccount) ? result.selectedAccount : accounts[0] || '';
        renderAccounts();
        if (account) createRepository();
        else { body.replaceChildren(node('p', 'git-repo-empty', '请在设置的环境配置中登录 GitHub')); openDialog(); }
      } catch (error) {
        if (alive && request === dialogSeq) { body.replaceChildren(); dialogMessage(error.message, true); openDialog(); }
      }
      return;
    }
    if (loadedAccount !== account) repositories = [];
    renderPicker(); openDialog();
    if (refresh) await refreshRemote();
    else if (loadedAccount !== account) await loadRepositories();
  }
  function summary(items) {
    const list = node('dl', 'git-repo-summary');
    for (const [label, value] of items) {
      list.append(node('dt', '', label), node('dd', '', value || '—'));
    }
    return list;
  }
  async function openFolder(repo) {
    if (!repo || mutating) return;
    operationControls(true);
    dialogMessage();
    try { await call('gitRepositoryOpenFolder', { account: repo.account || account, fullName: repo.fullName }); }
    catch (error) { dialogMessage(error.message, true); }
    finally { if (alive) operationControls(false); }
  }
  function renderManagement(draft = null) {
    if (!selected || !status) return;
    view = 'manage';
    dialog.dataset.view = 'manage';
    back.hidden = origin !== 'picker';
    title.textContent = selected.fullName;
    body.replaceChildren(summary([
      ['账号', selected.account || account], ['本地', status.localPath], ['分支', status.branch || selected.defaultBranch],
      ['同步', status.localPath ? `待推送 ${status.ahead || 0} · 待同步 ${status.behind || 0}${status.dirty ? ` · ${status.files?.length || 0} 个文件有改动` : ''}` : '尚未关联本地项目'],
    ]));
    if (status.localPath) {
      const overview = node('div', 'git-overview');
      const meta = node('div', 'git-overview-meta');
      const localPath = node('span', 'git-overview-path', status.localPath); localPath.title = status.localPath;
      meta.append(node('span', 'git-branch-badge', status.branch || selected.defaultBranch || '—'), localPath, node('span', 'git-sync-info', `待推送 ${status.ahead || 0} · 待同步 ${status.behind || 0}`));
      overview.append(meta); body.replaceChildren(overview);
    }
    const actions = node('div', 'git-repo-actions');
    if (status.localPath) {
      actions.append(button('gitRepoOpen', '打开文件夹', () => void openFolder(selected)));
      const update = button('gitRepoUpdate', '同步', () => void updateRepository());
      update.disabled = !!status.dirty || !!status.conflicts;
      if (status.dirty) update.title = '请先提交或处理本地改动';
      actions.append(update);
      const upload = button('gitRepoUpload', '推送', () => submitUpload(), 'mini-btn accent'); upload.disabled = (status.canPush ?? selected.canPush) === false;
      if (upload.disabled) upload.title = '当前账号没有此仓库的写入权限';
      actions.append(upload);
    } else {
      const directory = node('input'); directory.id = 'gitCloneDirectory'; directory.type = 'text'; directory.value = status.cloneDirectory || ''; directory.spellcheck = false;
      directory.setAttribute('aria-label', '默认克隆目录');
      const directoryRow = node('div', 'git-clone-directory');
      const saveDirectory = async browse => {
        if (mutating) return;
        const requestedDirectory = directory.value, request = dialogSeq;
        if (browse) operationControls(true);
        dialogMessage();
        try {
          const saved = await call('gitCloneDirectory', { directory: requestedDirectory, browse });
          if (alive && request === dialogSeq && saved && directory.value === requestedDirectory) { directory.value = saved; status.cloneDirectory = saved; }
        } catch (error) { if (alive && request === dialogSeq && directory.value === requestedDirectory) dialogMessage(error.message, true); }
        finally { if (alive && browse) operationControls(false); }
      };
      directory.addEventListener('change', () => void saveDirectory(false));
      directoryRow.append(directory, button('gitCloneBrowse', '浏览…', () => void saveDirectory(true)));
      body.append(directoryRow);
      actions.append(button('gitRepoClone', '克隆', () => void runOperation('正在克隆…', () => call('gitRepositoryClone', { ...target(), parent: directory.value }), '克隆完成', true), 'mini-btn accent'));
    }
    actions.append(button('gitRepoRefresh', '刷新状态', () => void openRepository(selected)));
    body.append(actions);
    if (status.localPath) {
      const files = new Map((status.pendingFiles || []).map(path => [path, '待推送']));
      for (const file of status.files || []) {
        const code = file.status || '';
        files.set(file.path, code.includes('?') ? '新增' : code.includes('D') ? '删除' : code.includes('R') ? '重命名' : code.includes('A') ? '新增' : '修改');
      }
      const list = node('div', 'git-pending-files'); list.id = 'gitPendingFiles';
      list.append(node('div', 'git-pending-heading', `待推送文件 · ${files.size}`));
      const split = node('div', 'git-pending-split'), navigation = node('div', 'git-pending-list');
      navigation.id = 'gitUploadFiles';
      const fileColumn = node('section', 'git-file-column'), fileHeader = node('div', 'git-file-header');
      fileHeader.append(node('span', '', '文件'), node('span', 'git-file-header-status', '状态'));
      fileColumn.append(fileHeader, navigation);
      const detail = node('section', 'git-pending-detail'), detailTitle = node('div', 'git-pending-detail-title');
      const detailPath = node('span', 'git-detail-path');
      detailTitle.append(node('span', 'git-detail-label', '改动预览'), detailPath);
      const content = node('pre', 'git-pending-content', files.size ? '请选择文件查看改动' : '暂无内容');
      const showPreview = result => {
        content.replaceChildren();
        content.classList.remove('is-loading');
        const empty = !result.text;
        content.classList.toggle('is-empty', empty);
        if (empty) {
          content.append(icon(['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6', 'M8 13h8M8 17h5']), node('span', '', '文件内容为空'));
          return;
        }
        const text = result.text;
        const lines = text.split('\n');
        for (const line of lines.slice(0, 4000)) {
          const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : '';
          content.append(node('span', `git-diff-line ${kind}`, line || ' '));
        }
        if (result.truncated || lines.length > 4000) content.append(node('span', 'git-diff-line', '… 内容过长，已截断'));
      };
      detail.append(detailTitle, content); split.append(fileColumn, detail); list.append(split);
      let previewSeq = 0;
      const previewCache = new Map(), pendingPreviews = new Map();
      let activePreview = '', firstPreview = null;
      const request = dialogSeq, repositoryTarget = target();
      if (!files.size) {
        const empty = node('div', 'git-pending-empty');
        empty.append(icon(['M9 12l2 2 4-4', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0']), node('span', '', status.ahead || (status.hasCommits && status.hasUpstream === false) ? '有本地提交待推送' : '暂无待推送文件'));
        list.replaceChildren(empty);
      }
      for (const [path, label] of files) {
        let checkbox;
        const loadPreview = async () => {
          if (activePreview === path) return;
          activePreview = path;
          const preview = ++previewSeq;
          navigation.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === row)));
          detailPath.textContent = path; detailPath.title = path;
          content.classList.remove('is-empty', 'is-loading'); content.replaceChildren();
          content.scrollTop = 0; content.scrollLeft = 0;
          if (previewCache.has(path)) { showPreview(previewCache.get(path)); return; }
          const isCurrent = () => alive && request === dialogSeq && preview === previewSeq && list.isConnected;
          const loadingTimer = setTimeout(() => {
            if (isCurrent()) { content.classList.add('is-loading'); content.textContent = '正在读取…'; }
          }, 150);
          try {
            if (!pendingPreviews.has(path)) {
              const pending = call('gitFilePreview', { ...repositoryTarget, file: path }).then(result => {
                previewCache.set(path, result);
                if (previewCache.size > 20) previewCache.delete(previewCache.keys().next().value);
                return result;
              }).finally(() => pendingPreviews.delete(path));
              pendingPreviews.set(path, pending);
            }
            const result = await pendingPreviews.get(path);
            if (isCurrent()) showPreview(result);
          } catch (error) {
            if (isCurrent()) { activePreview = ''; content.classList.remove('is-loading'); content.textContent = error.message; }
          } finally { clearTimeout(loadingTimer); }
        };
        const row = button('', '', () => {
          if (mutating) return;
          if (checkbox && !checkbox.disabled) { checkbox.checked = !checkbox.checked; checkbox.dispatchEvent(new Event('change', { bubbles: true })); }
          else void loadPreview();
        }, 'git-pending-row');
        firstPreview ||= loadPreview;
        row.removeAttribute('id'); row.setAttribute('aria-pressed', 'false'); row.title = path;
        const badge = node('span', 'git-pending-status', label); badge.dataset.kind = label;
        row.append(icon(['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6']), node('span', 'git-pending-path', path), badge);
        const entry = node('div', 'git-pending-entry');
        if ((status.files || []).some(file => file.path === path)) {
          checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = path; checkbox.setAttribute('aria-label', '推送 ' + path);
          checkbox.checked = draft?.paths.has(path) ? draft.selected.has(path) : defaultSelectedFile(path);
          checkbox.disabled = (status.canPush ?? selected.canPush) === false;
          checkbox.addEventListener('change', () => void loadPreview());
          entry.append(checkbox);
        }
        entry.append(row); navigation.append(entry);
      }
      body.append(list);
      void firstPreview?.();
      const footer = node('div', 'git-commit-footer');
      if (status.files?.length) {
        const label = node('label', 'git-field', '提交说明');
        const commit = node('input'); commit.id = 'gitCommitMessage'; commit.type = 'text'; commit.placeholder = '说明这次修改，留空由 AI 自动填写'; commit.maxLength = 500; commit.value = draft?.message || '';
        label.append(commit); footer.append(label);
      }
      const upload = body.querySelector('#gitRepoUpload');
      upload.disabled = (status.canPush ?? selected.canPush) === false || (!status.files?.length && !status.ahead && !(status.hasCommits && status.hasUpstream === false));
      actions.append(upload); actions.classList.add('git-bottom-actions');
      footer.append(actions); body.append(footer); placeDialogFeedback();
    }
    syncDialogControls();
  }
  async function updateRepository() {
    if (mutating) return;
    const request = dialogSeq;
    operationControls(true); dialogMessage();
    const update = body.querySelector('#gitRepoUpdate'); update.textContent = '同步中…';
    try {
      const result = await call('gitRepositoryUpdate', target());
      if (!alive || request !== dialogSeq) return;
      status = result.status; Object.assign(selected, result.repository || {});
      renderManagement();
      body.querySelector('#gitRepoUpdate').textContent = result.upToDate ? '已是最新' : '已同步';
      if (!result.upToDate) { await loadLocalRepositories(); await onChanged?.(status.localPath); }
    } catch (error) {
      if (alive && request === dialogSeq) { body.querySelector('#gitRepoUpdate').textContent = '重试同步'; dialogMessage(error.message, true); }
    } finally { if (alive) operationControls(false); }
  }
  const target = () => ({ account: selected.account || account, fullName: selected.fullName });
  async function openRepository(repo, { from = view === 'picker' ? 'picker' : origin } = {}) {
    if (mutating || authenticating) return;
    if (repo.account) account = repo.account;
    const request = ++dialogSeq, requestedAccount = repo.account || account;
    origin = from; view = 'manage'; listSeq++; loading = false;
    back.hidden = origin !== 'picker';
    dialog.dataset.view = 'manage';
    selected = repo; status = null; title.textContent = repo.fullName;
    body.replaceChildren(node('p', 'git-loading', '正在读取仓库状态…')); dialogMessage(); openDialog();
    try {
      const result = await call('gitRepositoryStatus', { account: requestedAccount, fullName: repo.fullName });
      if (!alive || request !== dialogSeq || requestedAccount !== account) return;
      status = result; renderManagement();
    } catch (error) {
      if (!alive || request !== dialogSeq) return;
      const actions = node('div', 'git-repo-actions');
      actions.append(button('gitRepoRetry', '重试', () => void openRepository(repo)), button('gitRepoAuth', '登录或切换账号', () => void openPicker()));
      if (repo.localPath) actions.append(button('gitRepoOpen', '打开文件夹', () => void openFolder(repo)));
      body.replaceChildren(actions);
      dialogMessage(error.message, true);
    }
  }
  function syncDialogControls() {
    panel.querySelectorAll('button, input, textarea, select').forEach(element => {
      if (mutating) {
        if (element.dataset.gitWasDisabled === undefined) element.dataset.gitWasDisabled = String(element.disabled);
        element.disabled = true;
      }
      else if (element.dataset.gitWasDisabled !== undefined) { element.disabled = element.dataset.gitWasDisabled === 'true'; delete element.dataset.gitWasDisabled; }
    });
    dialog.setAttribute('aria-busy', String(mutating));
  }
  function operationControls(busy) {
    mutating = busy; controls(); syncDialogControls();
  }
  async function runOperation(text, action, success, openCloned = false, progressButton = '') {
    if (mutating) return;
    const request = dialogSeq, repo = selected;
    const reviewingUpload = !!body.querySelector('#gitUploadFiles');
    const uploadDraft = reviewingUpload ? {
      paths: new Set([...body.querySelectorAll('#gitUploadFiles input')].map(input => input.value)),
      selected: new Set([...body.querySelectorAll('#gitUploadFiles input:checked')].map(input => input.value)),
      message: body.querySelector('#gitCommitMessage')?.value || '',
    } : null;
    const progress = label => {
      if (!alive || request !== dialogSeq || !progressButton) return;
      const control = body.querySelector('#' + progressButton);
      if (control) { control.textContent = label; control.classList.add('is-loading'); control.setAttribute('aria-busy', 'true'); }
    };
    let closeAfter = false;
    operationControls(true); dialogMessage(progressButton ? '' : text); progress(text);
    try {
      const result = await action(progress);
      if (!alive || request !== dialogSeq) return;
      if (!result || result.cancelled || result.canceled) { dialogMessage(); return; }
      const repository = result.repository || repo;
      if (repository && repo) Object.assign(repo, repository);
      status = result.status || await call('gitRepositoryStatus', target());
      renderManagement(); dialogMessage(progressButton ? '' : success); progress('正在刷新…'); renderRepositories();
      await loadLocalRepositories();
      try { await onChanged?.(status.localPath); }
      catch (error) { dialogMessage(`${success}，刷新文件列表失败：${error.message}`, true); }
      if (openCloned) {
        const cwd = result.cwd || status.localPath;
        if (cwd) {
          try { await (onClone || onOpenProject)?.(cwd); closeAfter = true; }
          catch (error) { dialogMessage(`克隆完成，打开项目失败：${error.message}`, true); }
        }
      }
    } catch (error) {
      if (alive && request === dialogSeq) {
        // A rejected push may leave a valid local commit. Read it back so its explicit retry is available.
        if (reviewingUpload && selected) {
          uploadDraft.message = body.querySelector('#gitCommitMessage')?.value || uploadDraft.message;
          try {
            const refreshed = await call('gitRepositoryStatus', target());
            if (alive && request === dialogSeq) { status = refreshed; renderManagement(uploadDraft); }
          } catch { /* Keep the original operation error if status cannot be refreshed. */ }
        }
        dialogMessage(error.message, true);
      }
    }
    finally {
      if (alive) {
        if (progressButton) {
          const control = body.querySelector('#' + progressButton);
          if (control) { control.textContent = '推送'; control.classList.remove('is-loading'); control.removeAttribute('aria-busy'); }
        }
        operationControls(false); if (closeAfter) closeDialog();
      }
    }
  }
  function submitUpload() {
    if (mutating || !selected || !status) return;
    const files = [...body.querySelectorAll('#gitUploadFiles input:checked')].map(input => input.value);
    const commit = body.querySelector('#gitCommitMessage');
    let message = commit?.value.trim() || '';
    if (!files.length && !status.ahead && !(status.hasCommits && status.hasUpstream === false)) { dialogMessage('请选择要推送的文件', true); return; }
    const request = dialogSeq, repositoryTarget = target(), cwd = status.localPath;
    void runOperation(files.length && !message ? 'AI 分析中…' : '推送中…', async progress => {
      if (files.length && !message) {
        const generated = await call('gitCommitMessage', { ...repositoryTarget, files });
        if (!alive || request !== dialogSeq) return { cancelled: true };
        message = generated?.message?.trim() || '';
        if (!message || message.length > 500) throw Error('AI 未能生成有效的提交说明，请重试或手动填写');
        if (commit) commit.value = message;
      }
      progress('推送中…');
      return call('gitRepositoryUpload', { ...repositoryTarget, cwd, files, message });
    }, '推送完成', false, 'gitRepoUpload');
  }
  function createRepository() {
    if (!account || mutating) return;
    const request = ++dialogSeq, requestedAccount = account;
    view = 'create'; origin = 'picker';
    dialog.dataset.view = 'create';
    back.hidden = false;
    selected = null; status = null; title.textContent = '新建 GitHub 仓库'; body.replaceChildren(); dialogMessage();
    body.append(summary([['账号', account]]));
    const nameLabel = node('label', 'git-field', '仓库名称');
    const name = node('input'); name.type = 'text'; name.id = 'gitRepoName'; name.placeholder = 'my-project'; name.maxLength = 100; name.autocomplete = 'off'; nameLabel.append(name);
    const descriptionLabel = node('label', 'git-field', '描述（可选）');
    const description = node('input'); description.type = 'text'; description.id = 'gitRepoDescription'; description.maxLength = 350; descriptionLabel.append(description);
    const privateLabel = node('label', 'git-private-label');
    const privateInput = node('input'); privateInput.type = 'checkbox'; privateInput.id = 'gitRepoPrivate'; privateInput.checked = true;
    privateLabel.append(privateInput, node('span', '', '私有仓库'));
    const actions = node('div', 'git-repo-actions');
    const submit = button('gitCreateSubmit', '创建仓库', async () => {
      if (mutating || !name.value.trim()) return;
      operationControls(true); dialogMessage('正在创建仓库…');
      try {
        const result = await call('gitRepositoryCreate', { account: requestedAccount, name: name.value.trim(), private: privateInput.checked, description: description.value.trim() });
        if (!alive || request !== dialogSeq || account !== requestedAccount) return;
        const repo = result.repository || result;
        if (!repo?.fullName) throw Error('未返回仓库信息，请刷新仓库列表');
        repositories.unshift(repo); renderRepositories();
        selected = repo; status = result.status || await call('gitRepositoryStatus', { account: requestedAccount, fullName: repo.fullName });
        renderManagement(); dialogMessage('仓库已创建');
      } catch (error) { if (alive && request === dialogSeq) dialogMessage(error.message, true); }
      finally { if (alive) operationControls(false); }
    }, 'mini-btn accent');
    submit.disabled = true;
    name.addEventListener('input', () => { submit.disabled = !name.value.trim(); });
    actions.append(submit); body.append(nameLabel, descriptionLabel, privateLabel, actions); openDialog(); name.focus();
  }
  listen(remote.search, 'input', renderRepositories);
  listen(elements.browse, 'click', () => void openPicker());
  listen(elements.create, 'click', () => void openPicker({ create: true }));
  const tab = root.querySelector('.nav-item[data-tab="git"]');
  if (tab) listen(tab, 'click', () => void activate());
  renderAccounts(); updateProjects();
  const refresh = loadLocalRepositories;
  async function activate() { await loadLocalRepositories(); }
  return {
    activate, refresh, updateProjects,
    destroy() { alive = false; authSeq++; listSeq++; localSeq++; dialogSeq++; listeners.forEach(remove => remove()); dialog.remove(); },
  };
}
