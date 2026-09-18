const domestic = /^(deepseek|moonshotai|minimax|zai|z-ai|zhipu|dashscope|alibaba|qwen|siliconflow|volcengine|doubao|baidu|tencent)(-|$)/i;
const subscription = /^(openai-codex|github-copilot|google-gemini-cli|google-antigravity)$/;

// Official CNY / million tokens, verified 2026-09-18:
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
function deepseekCost(message) {
  if (message.provider !== 'deepseek') return null;
  const time = Number(new Date(message.timestamp));
  const flash = /^(deepseek-flash|deepseek-v4(?:\.1)?-flash(?:-vision-exp)?)$/.test(message.model || '');
  const pro = message.model === 'deepseek-v4-pro';
  // Do not retrospectively apply today's tariff to older conversations.
  if (!Number.isFinite(time) || time < Date.parse(flash ? '2026-09-10T04:00:00Z' : '2026-08-16T16:00:00Z') || (!flash && !pro)) return null;
  const china = new Date(time + 8 * 3600000);
  const hour = china.getUTCHours(), day = china.getUTCDay();
  const peak = day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  const [input, cache, output] = flash ? [1, .02, 4] : [4.5, .15, 13.5];
  const u = message.usage;
  return ((u.input || 0) * input + (u.cacheRead || 0) * cache + (u.cacheWrite || 0) * input + (u.output || 0) * output) * (peak ? 2 : 1) / 1e6;
}

export class TurnCost {
  constructor() { this.messages = new Map(); }
  add(message) {
    if (message.__partial || !message.usage) return;
    const key = JSON.stringify([message.timestamp, message.provider, message.model, message.usage, message.content]);
    this.messages.set(key, message);
  }
  format(fx) {
    let cny = 0, usd = 0, hasCny = false, hasUsd = false, missing = false, subscribed = false, converted = false;
    for (const m of this.messages.values()) {
      if (subscription.test(m.provider || '')) { subscribed = true; continue; }
      const native = deepseekCost(m);
      if (native != null) { cny += native; hasCny = true; continue; }
      const amount = m.usage?.cost?.total;
      if (!Number.isFinite(amount) || amount <= 0) { missing = true; continue; }
      if (m.usage.cost.currency === 'CNY') { cny += amount; hasCny = true; }
      else if (domestic.test(m.provider || '')) {
        if (fx?.rate > 0) { cny += amount * fx.rate; hasCny = true; converted = true; }
        else missing = true;
      } else { usd += amount; hasUsd = true; }
    }
    const money = (n, symbol) => n > 0 && n < .0001 ? `<${symbol}0.0001` : symbol + n.toFixed(4);
    const parts = [hasCny && money(cny, '¥'), hasUsd && money(usd, '$')].filter(Boolean);
    if (subscribed) parts.push('订阅用量');
    if (missing) parts.push('部分费用未提供');
    return { text: parts.length ? (hasCny || hasUsd ? '约 ' : '') + parts.join(' + ') : '费用未提供',
      title: '本轮模型调用预估费用（含缓存与思考输出），不含图片、视频等工具费用；以平台账单为准。' +
        (converted ? ` 人民币折算汇率：1 USD = ${fx.rate} CNY（${fx.date}）。` : '') };
  }
}
