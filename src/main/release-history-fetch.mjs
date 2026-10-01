// Release history follows the current OS network route without changing app or OS proxy settings.
export function createReleaseHistoryFetch({ app, session }) {
  let historySession, ready, creating = false;

  function initialize() {
    if (!ready) {
      ready = (async () => {
        await app.whenReady();
        // Electron emits session-created synchronously inside fromPartition.
        creating = true;
        try {
          historySession = session.fromPartition('halo-release-history', { cache: false });
        } finally {
          creating = false;
        }
        await historySession.setProxy({ mode: 'system' });
        return historySession;
      })().catch(error => {
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  return {
    ownsSession(created) {
      return Boolean(created) && (creating || created === historySession);
    },
    async fetch(url, options) {
      const current = await initialize();
      return current.fetch(url, { ...options, credentials: 'omit' });
    },
  };
}
