const keyOf = file => String(file || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

export function presentConversations(store, rows) {
  const order = store.data.conversationOrder || [];
  const known = new Set(order);
  const added = rows.map(row => keyOf(row.file)).filter(key => key && !known.has(key) && known.add(key));
  const next = [...added, ...order];
  if (added.length) { store.data.conversationOrder = next; store.save(); }
  const ranks = new Map(next.map((key, index) => [key, index]));
  return rows.map(row => ({...row, name: store.data.conversationNames?.[keyOf(row.file)] || row.name}))
    .sort((a, b) => ranks.get(keyOf(a.file)) - ranks.get(keyOf(b.file)));
}

export function renameConversation(store, file, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw Error('请输入 1–120 个字符的对话名称');
  store.data.conversationNames = {...store.data.conversationNames, [keyOf(file)]: name.trim()};
  store.save();
  return name.trim();
}
