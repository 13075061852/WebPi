// Only explicit credential failures expire an account. A generic 403 may be
// a gateway/WAF response, and temporary server failures must remain retryable.
export function quotaAuthExpired(error) {
  const message = String(error?.message || '');
  // Pi's OAuth adapter reports HTTP status in its Error message, rather than
  // attaching a status property (e.g. "token refresh failed (401)").
  const reported = message.match(/(?:\bHTTP\s+|\bstatus(?:\s+code)?\s*[:=]?\s*|\btoken (?:refresh|exchange) failed\s*\()(\d{3})/i);
  const status = Number(error?.status ?? error?.statusCode ?? reported?.[1]);
  if (status === 429 || status >= 500) return false;
  if (error?.authExpired === true || status === 401) return true;
  const detail = [error?.code, message, error?.details].filter(Boolean).join(' ');
  return /\b(?:invalid_grant|invalid_token|token_expired|expired_token|invalid_api_key|refresh_token_(?:expired|reused|invalidated)|account_deactivated)\b/i.test(detail) ||
    /\b(?:access[ _-]?token|refresh[ _-]?token|api[ _-]?key|credential)s?\b.{0,48}\b(?:invalid|expired|revoked|already (?:used|rotated))\b/i.test(detail) ||
    /\b(?:invalid|expired|revoked)\s+(?:(?:access|refresh)\s+)?(?:token|api[ _-]?key|credential)s?\b/i.test(detail) ||
    /\btoken (?:refresh|exchange) response missing fields\b/i.test(detail) ||
    /^Failed to extract accountId from token$/i.test(message);
}

export function quotaAuthError(message) {
  return Object.assign(new Error(message), { authExpired: true });
}

export function quotaResponseError(response, body, label) {
  const detail = body?.error || body?.detail || body?.message || body?.msg;
  return Object.assign(new Error(`${label} HTTP ${response.status}`), {
    status: response.status,
    details: typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
  });
}

export function quotaFailure(error, kind, previous) {
  if (quotaAuthExpired(error)) return { kind, error: true, authExpired: true };
  return previous || { kind, error: true };
}
