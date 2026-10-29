const storageKey = 'halo-session-preview-state';
const normalize = value => String(value || '').replaceAll('\\', '/').toLowerCase();
export function createSessionPreviewState(storage) {
  let saved;
  try { saved = JSON.parse(storage.getItem(storageKey) || '[]'); } catch {}
  const states = new Map(Array.isArray(saved) ? saved.filter(row => Array.isArray(row) && typeof row[0] === 'string' && (typeof row[1] === 'boolean' || (row[1] && typeof row[1].collapsed === 'boolean'))) : []);
  for (const [key, value] of states) if (typeof value === 'boolean') states.set(key, { collapsed: value });
  let current = '', currentIdentity = '';
  const persist = () => { try { storage.setItem(storageKey, JSON.stringify([...states])); } catch {} };
  return {
    activate(state) {
      const identity = state?.sessionId || normalize(state?.sessionFile);
      const sessionKey = identity ? JSON.stringify([state?.serverId || '', identity]) : '';
      // Empty drafts have no durable session file and receive a new ID after
      // restart. There is one reusable draft per project/server in the bridge.
      const key = state?.messageCount === 0 && state?.cwd
        ? JSON.stringify([state.serverId || '', 'draft', normalize(state.cwd)]) : sessionKey;
      if (!key) return null;
      if (key === current) { currentIdentity = sessionKey; return null; }
      if (!states.has(key)) {
        const previous = sessionKey === currentIdentity ? states.get(current) : states.get(sessionKey);
        if (previous) { states.set(key, { ...previous }); persist(); }
      }
      current = key;
      currentIdentity = sessionKey;
      return { collapsed: true, ...states.get(key) };
    },
    target() { return states.get(current)?.target || null; },
    website() {
      const state = states.get(current);
      return state?.lastWebsite || (state?.target?.kind === 'website' ? { url: state.target.url } : null);
    },
    rememberTarget(target) {
      if (!current) return;
      const previous = states.get(current)?.target;
      if (target?.kind === 'website') {
        target = { ...target, previousFile: previous?.kind === 'file' ? previous : previous?.previousFile || null };
      }
      states.set(current, { collapsed: true, ...states.get(current), target,
        ...(target?.kind === 'website' ? { lastWebsite: { url: target.url } } : {}) });
      persist();
    },
    remember(collapsed) {
      if (!current) return;
      states.set(current, { ...states.get(current), collapsed: !!collapsed });
      persist();
    },
  };
}
