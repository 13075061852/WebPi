// Observe the bridge stream in the main process so background conversations
// still notify even when their renderer view is not selected.
export function createCompletionNotifications({ Notification, focusWindow, enabled = () => true }) {
  const runs = new Map();
  const activeNotifications = new Set();
  function observe(channel, payload) {
    if (channel !== 'pi:event' || !payload?.sessionId || !payload.event) return;
    const { sessionId, event } = payload;
    if (event.type === 'agent_start') {
      if (!runs.has(sessionId)) runs.set(sessionId, { sawUser: false, stopReason: null });
      return;
    }
    const run = runs.get(sessionId);
    if (!run) return;
    if (event.type === 'message_start' && event.message?.role === 'user') {
      run.sawUser = true;
      run.stopReason = null;
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      run.stopReason = event.message.stopReason || null;
    } else if (event.type === 'agent_settled') {
      runs.delete(sessionId);
      if (!run.sawUser || event.aborted || !['stop', 'length', 'error'].includes(run.stopReason) || !enabled()) return;
      let notification;
      try {
        if (!Notification.isSupported()) return;
        const completed = run.stopReason === 'stop';
        notification = new Notification({
          title: completed ? 'AI 回复已完成' : 'AI 回复未完成',
          body: completed ? '点击返回 Pi Halo 查看回复' : '点击返回 Pi Halo 查看详情',
        });
        activeNotifications.add(notification);
        notification.once('close', () => activeNotifications.delete(notification));
        notification.once('click', () => { activeNotifications.delete(notification); focusWindow(); });
        notification.show();
      } catch {
        if (notification) activeNotifications.delete(notification);
        // Desktop notifications can be unavailable or disabled by the OS.
      }
    }
  }
  return { observe };
}
