// Streaming providers generally report usage only at message_end. Keep live
// estimates explicit and exclude tool execution / request waiting from averages.
export class OutputRate {
  constructor() { this.tokens = 0; this.ms = 0; this.estimated = false; this.start(); }
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
