import assert from 'node:assert/strict';
import fs from 'node:fs';
import { iconLibraryTool } from '../src/main/icon-library.mjs';

const tool = iconLibraryTool();
const call = async args => JSON.parse((await tool.execute('test', args)).content[0].text);
const search = await call({ query: 'lightbulb' });
assert.ok(search.names.includes('lightbulb'));
assert.ok((await call({})).names.length <= 40);
assert.equal((await call({ query: 'nonexistent-xyz-fixture' })).total, 0);
const result = await call({ names: ['lightbulb', 'shuffle', 'rotate-ccw', 'volume-2'] });
assert.equal(result.icons.length, 4);
assert.match(result.license, /Permission/);
for (const { svg } of result.icons) assert.match(svg, /<svg[\s\S]*viewBox="0 0 24 24"/);
await assert.rejects(() => call({ names: ['../../package.json'] }), /未知图标/);
await assert.rejects(() => call({ names: ['__proto__'] }), /未知图标/);
await assert.rejects(() => call({ names: Array(13).fill('lightbulb') }), /1–12/);
await assert.rejects(() => tool.execute('test', {}, AbortSignal.abort()), /取消/);
const data = JSON.parse(fs.readFileSync(new URL('../assets/icons/lucide.json', import.meta.url)));
for (const svg of Object.values(data.icons)) {
  assert.doesNotMatch(svg, /<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=/i);
}
const bridge = fs.readFileSync(new URL('../src/main/pi-bridge.mjs', import.meta.url), 'utf8');
assert.match(bridge, /customTools: \[\.\.\.extraTools, iconLibraryTool\(\)/);
console.log(`PASS offline icon search, SVG retrieval, license, validation, cancellation, ${Object.keys(data.icons).length} static icons, shared runtime registration`);
