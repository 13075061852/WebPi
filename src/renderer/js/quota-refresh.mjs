/** Keep every completed step's quota check, even when the previous check is still running. */
export function createQuotaRefreshQueue({ request, currentProvider, apply }) {
  let tail = Promise.resolve();
  let generation = 0;
  return {
    enqueue(provider, force = false) {
      const expectedGeneration = generation;
      const task = tail.catch(() => {}).then(async () => {
        if (!provider || expectedGeneration !== generation || currentProvider() !== provider) return;
        const reply = await request(provider, force);
        if (reply?.ok && expectedGeneration === generation && currentProvider() === provider) apply(provider, reply.data);
      });
      tail = task;
      return task;
    },
    invalidate() { generation++; },
  };
}
