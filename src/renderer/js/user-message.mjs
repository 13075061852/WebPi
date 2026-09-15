/** Display-only projection of Pi's expanded skill invocation. Never alters model input. */
export function userMessageText(value) {
  let text = String(value || '').replace(/^\[当前会话托管服务器:[^\n]*涉及该服务器的命令和文件操作必须使用 ssh_exec，不要在本地 bash\/read\/write 执行远程操作。\]\s*/, '');
  const skill = text.match(/^<skill name="([^"\r\n]+)" location="[^"\r\n]+">\r?\nReferences are relative to [^\r\n]+\r?\n[\s\S]*?\r?\n<\/skill>(?:\r?\n|$)/);
  if (skill) text = `/skill:${skill[1]}${text.slice(skill[0].length).trim() ? ' ' + text.slice(skill[0].length).trim() : ''}`;
  return text;
}

/** Project SDK user content into the same shape for live events and history. */
export function userMessageParts(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: message?.content || '' }];
  return {
    text: blocks.filter(c => c?.type === 'text').map(c => c.text || '').join('\n'),
    images: blocks.filter(c => c?.type === 'image' && c.data && c.mimeType)
      .map(c => ({ mediaType: c.mimeType, data: c.data, name: '附件' })),
  };
}
