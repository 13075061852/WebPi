const normalize = file => String(file || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();

export function syncConversationSelection(file, root = document) {
  const current = normalize(file);
  for (const button of root.querySelectorAll('[data-conversation-file]')) {
    const active = !!current && normalize(button.dataset.conversationFile) === current;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}
