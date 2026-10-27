// Pi 1.4.0 still has no public queue move operation. Isolate its two
// synchronous queue writers here, retaining already expanded input and images.
export async function promoteQueuedMessage(session, index, expected, beforeQueue = () => {}) {
  const pending = [...session.getFollowUpMessages()];
  if (!Number.isInteger(index) || index < 0 || index >= pending.length || JSON.stringify(pending) !== JSON.stringify(expected)) {
    throw new Error('队列已变化，请重新确认');
  }
  if (typeof session._queueSteer !== 'function' || typeof session._queueFollowUp !== 'function') throw new Error('当前核心不支持移动队列消息');
  const agent = session.agent;
  const steeringMode = agent.steeringMode, followUpMode = agent.followUpMode;
  let steering = [], followUp;
  try {
    agent.steeringMode = 'all'; agent.followUpMode = 'all';
    if (session.getSteeringMessages().length) {
      steering = agent.peekQueuedMessages();
      agent.clearSteeringQueue();
    }
    followUp = agent.peekQueuedMessages();
  } finally {
    for (const message of steering) agent.steer(message);
    agent.steeringMode = steeringMode; agent.followUpMode = followUpMode;
  }
  if (followUp.length !== pending.length) throw new Error('队列正在执行，请稍后重试');
  const tasks = [];
  session.clearQueue();
  const enqueue = (message, kind, oldIndex) => {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const images = message.content.filter(part => part.type === 'image');
    beforeQueue(kind, oldIndex);
    tasks.push(kind === 'steering' ? session._queueSteer(text, images) : session._queueFollowUp(text, images));
  };
  steering.forEach((message, i) => enqueue(message, 'steering', i));
  enqueue(followUp[index], 'steering', -1);
  followUp.forEach((message, i) => { if (i !== index) enqueue(message, 'followUp', i); });
  await Promise.all(tasks);
}

// Pi 1.4.0 exposes only whole-queue clearing. Rebuild the affected queue
// synchronously so the running agent cannot consume a different item midway.
export function removeQueuedMessage(session, kind, index, expected, beforeEmit = () => {}) {
  if (kind !== 'steering' && kind !== 'followUp') throw new Error('无效的队列类型');
  const pending = kind === 'steering' ? session.getSteeringMessages() : session.getFollowUpMessages();
  if (!Number.isInteger(index) || index < 0 || index >= pending.length || JSON.stringify(pending) !== JSON.stringify(expected)) {
    throw new Error('队列已变化，请重新确认');
  }
  const agent = session.agent;
  if (!agent || typeof session._emitQueueUpdate !== 'function' || !Array.isArray(session._steeringMessages) || !Array.isArray(session._followUpMessages)) {
    throw new Error('当前核心不支持撤回等待消息');
  }
  const steeringMode = agent.steeringMode, followUpMode = agent.followUpMode;
  let steering = [], messages;
  try {
    agent.steeringMode = 'all'; agent.followUpMode = 'all';
    if (kind === 'followUp' && session.getSteeringMessages().length) {
      steering = agent.peekQueuedMessages();
      agent.clearSteeringQueue();
    }
    messages = agent.peekQueuedMessages();
  } finally {
    for (const message of steering) agent.steer(message);
    agent.steeringMode = steeringMode; agent.followUpMode = followUpMode;
  }
  if (messages.length !== pending.length) throw new Error('消息正在执行，无法撤回');
  if (kind === 'steering') agent.clearSteeringQueue(); else agent.clearFollowUpQueue();
  messages.forEach((message, i) => {
    if (i !== index) {
      if (kind === 'steering') agent.steer(message); else agent.followUp(message);
    }
  });
  (kind === 'steering' ? session._steeringMessages : session._followUpMessages).splice(index, 1);
  beforeEmit();
  session._emitQueueUpdate();
  return messages[index];
}
