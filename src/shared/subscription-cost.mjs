export const isSubscriptionProvider = (provider) => /^(openai-codex|github-copilot|google-gemini-cli|google-antigravity)$/.test(provider || '');

// Rates come from the active Pi model catalog, in USD per million tokens.
export function estimateSubscriptionCost(model, usage) {
  if (!model?.cost || !usage) return null;
  const tokens = ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => Number(usage[key] || 0));
  if (tokens.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [input, output, cacheRead, cacheWrite] = tokens;
  const totalInput = input + cacheRead + cacheWrite;
  const tiers = Array.isArray(model.cost.tiers) ? model.cost.tiers : [];
  const rates = tiers.filter((tier) => Number.isFinite(tier.inputTokensAbove) && totalInput > tier.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] || model.cost;
  const values = ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => Number(rates[key]));
  if (values.some((n) => !Number.isFinite(n) || n < 0) || !values.some((n) => n > 0)) return null;
  const [inputRate, outputRate, cacheReadRate, cacheWriteRate] = values;
  const longWrite = Math.min(cacheWrite, Math.max(0, Number(usage.cacheWrite1h) || 0));
  return (input * inputRate + output * outputRate + cacheRead * cacheReadRate +
    (cacheWrite - longWrite) * cacheWriteRate + longWrite * inputRate * 2) / 1e6;
}
