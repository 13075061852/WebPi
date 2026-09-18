// Public reference FX only; no account data or credentials leave the app.
export async function refreshBillingFx(store) {
  const cached = store.data?.billingFx;
  if (cached?.rate > 0 && Date.now() - cached.fetchedAt < 86400000) return cached;
  if (process.env.PI_OFFLINE === '1') return cached || null;
  try {
    const response = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return cached || null;
    const data = await response.json();
    if (!(data.rates?.CNY > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return cached || null;
    const value = { rate: data.rates.CNY, date: data.date, fetchedAt: Date.now() };
    store.set('billingFx', value);
    return value;
  } catch { return cached || null; }
}
