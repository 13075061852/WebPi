import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatePi } from './helpers/isolated-pi.mjs';

const fixture = isolatePi('halo-subscription-usage-');
try {
  const { PiBridge } = await import('../src/main/pi-bridge.mjs');
  const sessionDir = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', 'fixture');
  fs.mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const entry = (model, usage) => JSON.stringify({ type:'message', timestamp,
    message:{ role:'assistant', provider:'openai-codex', model, usage } });
  fs.writeFileSync(path.join(sessionDir, 'usage.jsonl'), [
    JSON.stringify({ type:'session', cwd:fixture.dir }),
    entry('gpt-6-astra', { input:1000, output:1000, cacheRead:0, cacheWrite:0, cost:{total:0} }),
    entry('unknown-model', { input:1000, output:0, cacheRead:0, cacheWrite:0, cost:{total:0} }),
  ].join('\n'));
  const model = { cost:{ input:10, output:50, cacheRead:1, cacheWrite:12.5 } };
  const bridge = { modelRuntime:{ getModel:(_provider, id) => id === 'gpt-6-astra' ? model : null } };
  const summary = await PiBridge.prototype.usageSummary.call(bridge, 1);
  assert.equal(summary.totals.cost, .06);
  assert.equal(summary.totals.unpriced, 1);
  assert.equal(summary.today.cost, .06);
  assert.equal(summary.sessionDetails[0].cost, .06);
  assert.equal(summary.models.find(row => row.key.endsWith('/gpt-6-astra')).cost, .06);
  assert.equal(summary.models.find(row => row.key.endsWith('/unknown-model')).unpriced, 1);
  console.log('PASS subscription history: model-specific price, zero SDK cost, missing catalog price');
} finally {
  fixture.cleanup();
}
