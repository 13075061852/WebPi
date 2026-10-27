// Pi 1.4.0 has no public operation to start an idle follow-up queue. Keep this
// adapter beside queue-promotion: inputs here already passed SDK handlers and
// skill/template expansion, so starting them must not process that input twice.
export async function startCompactionQueue(session) {
  if (session.isStreaming || session.isCompacting || !session.getFollowUpMessages().length) return;
  if (typeof session._startRun !== 'function' || typeof session._emitQueueUpdate !== 'function') {
    throw new Error('当前核心不支持压缩后执行队列');
  }
  const agent = session.agent;
  const mode = agent.followUpMode;
  let messages;
  try {
    agent.followUpMode = 'all';
    messages = agent.peekQueuedMessages();
  } finally {
    agent.followUpMode = mode;
  }
  const [message, ...rest] = messages;
  if (!message || session.getSteeringMessages().length || messages.length !== session.getFollowUpMessages().length) throw new Error('压缩后的消息队列已变化');
  // peekQueuedMessages does not consume. Pull just this first follow-up, keeping
  // the SDK's remaining queue, image blocks and one-at-a-time delivery intact.
  agent.clearFollowUpQueue();
  for (const item of rest) agent.followUp(item);
  session._followUpMessages.shift();
  let started = false;
  try {
    await session._startRun({ messageType: 'user',
      prompt: message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
      images: message.content.filter(part => part.type === 'image') }, () => {
      started = true;
      session._emitQueueUpdate();
    });
  } catch (error) {
    if (!started) {
      // Preparation failed before accepting the user message. Keep it retryable.
      const currentMode = agent.followUpMode;
      agent.followUpMode = 'all';
      const pending = agent.peekQueuedMessages();
      agent.followUpMode = currentMode;
      agent.clearFollowUpQueue();
      agent.followUp(message);
      for (const item of pending) agent.followUp(item);
      session._followUpMessages.unshift(message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
      session._emitQueueUpdate();
    }
    throw error;
  }
}
