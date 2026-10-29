const key = 'halo-workspace';
export function createWorkspaceMemory(storage) {
  let saved;
  try { saved = JSON.parse(storage.getItem(key) || 'null'); } catch {}
  if (!saved || typeof saved !== 'object' || typeof saved.cwd !== 'string') saved = null;
  let restoring = true;
  return {
    initial: () => restoring ? saved : null,
    finish() { restoring = false; saved = null; },
    remember(state, tab) {
      // Startup emits a default focus before restoration. Never replace the
      // previous selection until its project/conversation have been restored.
      if (restoring || !state?.ready || !state.cwd) return;
      try { storage.setItem(key, JSON.stringify({ cwd: state.cwd, session: state.sessionFile || '',
        serverId: state.serverId || null, draft: state.messageCount === 0,
        tab: ['chat', 'skills', 'git'].includes(tab) ? tab : 'chat' })); } catch {}
    },
  };
}
