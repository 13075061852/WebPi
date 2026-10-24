// Automatic folds are separate from the user's saved sidebar/preview choices.
export function initResponsiveLayout({ onToggleSidebar, onChange = () => {} } = {}) {
  const body = document.body;
  const previewQuery = matchMedia('(max-width: 1119px)');
  const sidebarQuery = matchMedia('(max-width: 759px)');
  const sidebar = document.querySelector('#sidebar');
  const center = document.querySelector('#center');
  const chat = document.querySelector('#chat');
  const exclusiveButton = document.querySelector('#btnPreviewExclusive');
  const sidebarButton = document.querySelector('#btnChatSidebar');
  const previewButton = document.querySelector('#btnPreviewToggle');
  const sync = () => {
    body.classList.toggle('preview-auto-collapsed', previewQuery.matches);
    body.classList.toggle('sb-auto-collapsed', sidebarQuery.matches);
    const focused = body.classList.contains('focus-mode');
    const exclusive = body.classList.contains('preview-exclusive');
    const drawer = sidebarQuery.matches && body.classList.contains('sb-drawer-open');
    const sidebarHidden = focused || (!drawer && (sidebarQuery.matches || body.classList.contains('sb-collapsed')));
    const previewHidden = focused || (!exclusive && (previewQuery.matches || body.classList.contains('preview-collapsed')));
    sidebar.inert = sidebarHidden;
    center.inert = previewHidden;
    chat.inert = exclusive;
    exclusiveButton.classList.toggle('active', exclusive);
    exclusiveButton.setAttribute('aria-pressed', String(exclusive));
    exclusiveButton.setAttribute('aria-expanded', String(!exclusive));
    exclusiveButton.title = exclusive ? '恢复聊天区' : '预览独享（收起聊天区）';
    exclusiveButton.setAttribute('aria-label', exclusiveButton.title);
    sidebarButton.setAttribute('aria-expanded', String(!sidebarHidden));
    sidebarButton.title = sidebarHidden ? '展开侧栏' : '收起侧栏';
    sidebarButton.setAttribute('aria-label', sidebarButton.title);
    previewButton.setAttribute('aria-expanded', String(!previewHidden));
    previewButton.title = previewQuery.matches ? '展开预览区（自动加宽窗口）' : previewHidden ? '展开预览区' : '收起预览区';
    previewButton.setAttribute('aria-label', previewButton.title);
    onChange();
  };
  const breakpointChanged = () => {
    body.classList.remove('sb-drawer-open');
    sync();
  };
  sidebarButton.addEventListener('click', () => {
    body.classList.remove('focus-mode');
    if (sidebarQuery.matches) body.classList.toggle('sb-drawer-open');
    else onToggleSidebar();
    sync();
  });
  document.addEventListener('pointerdown', event => {
    if (!sidebar.contains(event.target) && !sidebarButton.contains(event.target)) body.classList.remove('sb-drawer-open');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && body.classList.contains('sb-drawer-open')) {
      body.classList.remove('sb-drawer-open');
      sidebarButton.focus();
    }
  });
  previewQuery.addEventListener('change', breakpointChanged);
  sidebarQuery.addEventListener('change', breakpointChanged);
  // Manual folds, file selection and focus mode still use the existing controls.
  const observer = new MutationObserver(sync);
  observer.observe(body, { attributes: true, attributeFilter: ['class'] });
  sync();
}
