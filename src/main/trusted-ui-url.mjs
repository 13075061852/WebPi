/** Compare the exact UI document, respecting Windows path case semantics. */
export function isTrustedUIURL(actual, expected, platform = process.platform) {
  try {
    const a = new URL(actual), b = new URL(expected);
    if (a.protocol !== 'file:' || b.protocol !== 'file:' || a.search || a.hash) return false;
    const normalize = url => platform === 'win32' ? url.href.toLowerCase() : url.href;
    return normalize(a) === normalize(b);
  } catch { return false; }
}
