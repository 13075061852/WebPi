import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { OutputRate } from '../src/renderer/js/output-rate.mjs';

const source = fs.readFileSync('src/main/pi-bridge.mjs', 'utf8');
const method = source.slice(source.indexOf('  publicState() {'), source.indexOf('  /* ---------------- lifecycle'));
const state = vm.runInNewContext(`({${method}})`, { pi: { estimateTokens: m => m.estimate } });
state.session = { messages: [{ role: 'assistant', usage: { input: 223500 }, estimate: 2000 }],
  getContextUsage: () => ({ tokens: null }) };
assert.equal(state.publicState().contextTokens, 2000, 'old usage must not survive compaction');
assert.equal(state.publicState().contextEstimated, true);
state.session.getContextUsage = () => ({ tokens: 3500 });
assert.equal(state.publicState().contextTokens, 3500);
assert.equal(state.publicState().contextEstimated, false);
state.session = null;
assert.equal(state.publicState().contextTokens, 0);

const rate = new OutputRate();
rate.delta('a'.repeat(40), 1000);
rate.delta('a'.repeat(40), 2000);
assert.equal(rate.live(2000), '约 20.0 token/s');
assert.equal(rate.live(6000), '约 0.0 token/s', 'tool idle time decays to zero');
rate.end({output: 50}, 6000);
assert.equal(rate.average(), '50.0 token/s');
rate.start();
rate.delta('你好', 20000);
rate.delta('你好', 21000);
rate.end({output: 10}, 22000);
assert.equal(rate.average(), '30.0 token/s', 'exclude time waiting for tools');
assert.equal(new OutputRate().average(), '', 'no invented rate for restored history');
console.log('PASS rebuilt context after compaction, fresh usage, live rate, idle decay, usage calibrated average');
