/** The model context is compacted/edited; it is not the visible transcript. */
export function conversationHistory(session) {
  const live = session?.messages || [];
  if (!session?.sessionManager?.getBranch) return live;
  const messages = session.sessionManager.getBranch()
    .filter(entry => entry.type === 'message')
    .map(entry => entry.message);
  // Public message events arrive before SDK persistence. Retain that live tail
  // without duplicating persisted messages or adding synthetic context summaries.
  const key = message => message.timestamp != null
    ? `${message.role}:${message.toolCallId || ''}:${message.timestamp}`
    : JSON.stringify(message);
  const counts = new Map();
  for (const message of messages) {
    const id = key(message);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const message of live) {
    if (!['user', 'assistant', 'toolResult'].includes(message.role)) continue;
    const id = key(message), count = counts.get(id) || 0;
    if (count) counts.set(id, count - 1);
    else messages.push(message);
  }
  return messages;
}
