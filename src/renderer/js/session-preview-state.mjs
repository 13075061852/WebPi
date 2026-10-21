const storageKey = 'halo-session-preview-state';
const normalize = value => String(value || '').replaceAll('\\', '/').toLowerCase();
export function createSessionPreviewState(storage) {
  let saved;
  try { saved = JSON.parse(storage.getItem(storageKey) || '[]'); } catch {}
  const states = new Map(Array.isArray(saved) ? saved.filter(row => Array.isArray(row) && typeof row[0] === 'string' && (typeof row[1] === 'boolean' || (row[1] && typeof row[1].collapsed === 'boolean'))) : []);
  for (const [key, value] of states) if (typeof value === 'boolean') states.set(key, { collapsed: value });
  let current = '';
  const persist = () => { try { storage.setItem(storageKey, JSON.stringify([...states])); } catch {} };
  return {
    activate(state) {
      const identity = state?.sessionId || normalize(state?.sessionFile);
      const key = identity ? JSON.stringify([state?.serverId || '', identity]) : '';
      if (!key || key === current) return null;
      current = key;
      return { collapsed: true, ...states.get(key) };
    },
    target() { return states.get(current)?.target || null; },
    rememberTarget(target) {
      if (!current) return;
      const previous = states.get(current)?.target;
      if (target?.kind === 'website') {
        target = { ...target, previousFile: previous?.kind === 'file' ? previous : previous?.previousFile || null };
      }
      states.set(current, { collapsed: true, ...states.get(current), target });
      persist();
    },
    remember(collapsed) {
      if (!current) return;
      states.set(current, { ...states.get(current), collapsed: !!collapsed });
      persist();
    },
  };
}
