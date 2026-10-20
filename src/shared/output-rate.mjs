// Streaming providers generally report usage only at message_end. Keep live
// estimates explicit and exclude tool execution / request waiting from averages.
export class OutputRate {
  constructor(saved) {
    const valid = Number.isFinite(saved?.tokens) && saved.tokens > 0 && Number.isFinite(saved?.ms) && saved.ms > 0;
    this.tokens = valid ? saved.tokens : 0;
    this.ms = valid ? saved.ms : 0;
    this.estimated = valid && saved.estimated === true;
    this.start();
  }
  snapshot() { return { tokens: this.tokens, ms: this.ms, estimated: this.estimated }; }
  addHistorical(message) {
    if (!(Number.isFinite(message?.durationMs) && message.durationMs > 0 && Number.isFinite(message?.usage?.output) && message.usage.output > 0)) return;
    this.tokens += message.usage.output;
    this.ms += message.durationMs;
    // Historical request duration includes waiting for the first token.
    this.estimated = true;
  }
  start() { this.first = null; this.last = null; this.chars = 0; this.samples = []; }
  delta(text, now = Date.now()) {
    if (!text) return;
    this.first ??= now;
    this.last = now;
    const tokens = Array.from(text).reduce((n, c) => n + (/[^\x00-\x7f]/.test(c) ? 1 : 0.25), 0);
    this.chars += tokens;
    this.samples.push({ now, tokens });
    this.samples = this.samples.filter(s => now - s.now <= 3000);
  }
  end(usage, now = Date.now()) {
    if (this.first == null) return;
    const exact = Number.isFinite(usage?.output) && usage.output > 0;
    this.tokens += exact ? usage.output : this.chars;
    this.estimated ||= !exact;
    this.ms += Math.max(500, (this.last ?? now) - this.first);
    this.first = null;
    this.samples = [];
  }
  live(now = Date.now()) {
    const tokens = this.samples.filter(s => now - s.now <= 3000).reduce((n, s) => n + s.tokens, 0);
    return `约 ${(tokens / (Math.max(500, Math.min(3000, now - (this.first ?? now))) / 1000)).toFixed(1)} token/s`;
  }
  average() { return this.ms ? `${this.estimated ? '约 ' : ''}${(this.tokens / (this.ms / 1000)).toFixed(1)} token/s` : ''; }
}
