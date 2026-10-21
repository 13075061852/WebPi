import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { listBuiltinSkills, builtinDeliveryPolicy, filterBuiltinSkills } from '../src/main/builtin-skills.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { createPackageWithOptions } = require('@electron/asar');
const { runtimeAssetUnpackPatterns } = require('../build/prepare-package.cjs');
const skillRoot = path.join(root, 'assets/skills/halo-video-subtitles');
const catalog = listBuiltinSkills().find(skill => skill.name === 'halo-video-subtitles');
assert.ok(catalog?.enabled);
assert.equal(catalog.title, '视频中文字幕');
const settings = { disabledBuiltinSkills: ['halo-video-subtitles'] };
assert.equal(listBuiltinSkills(settings).find(skill => skill.name === catalog.name).enabled, false);
const builtin = { name: catalog.name, filePath: path.join(skillRoot, 'SKILL.md') };
const external = { name: catalog.name, filePath: path.join(root, 'tmp/project/.pi/skills/halo-video-subtitles/SKILL.md') };
assert.deepEqual(filterBuiltinSkills({ skills: [builtin, external] }, settings).skills, [external]);
const policy = fs.readFileSync(path.join(root, 'assets/delivery-policy.md'), 'utf8');
assert.ok(policy.includes('`halo-video-subtitles`'));
assert.ok(!builtinDeliveryPolicy(policy, settings).includes('`halo-video-subtitles`'));

const { normalizeCues, makeSrt } = require('../assets/skills/halo-video-subtitles/scripts/subtitle.cjs');
assert.throws(() => normalizeCues([{start:0,end:2,text:'一'},{start:1,end:3,text:'二'}]), /overlapping/);
assert.throws(() => normalizeCues([{start:0,end:Number.NaN,text:'一'}]), /timing/);
assert.throws(() => normalizeCues([{start:0,end:2,text:'a\n\nb'}]), /text/);
assert.match(makeSrt({cues:[{start:0,end:2,target:'中文字幕'}]}), /00:00:00,000 --> 00:00:02,000\n中文字幕/);
assert.ok(!fs.existsSync(path.join(skillRoot, 'scripts/subtitle_video.py')), 'Heavy Python ASR helper must be removed');
assert.ok(!fs.existsSync(path.join(skillRoot, 'scripts/bootstrap.ps1')), 'Heavy installer must be removed');

// External Node processes cannot execute virtual files inside app.asar.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-subtitle-asar-'));
try {
  const source = path.join(fixture, 'source');
  const relative = 'assets/skills/halo-video-subtitles/scripts/subtitle.cjs';
  fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
  fs.copyFileSync(path.join(root, relative), path.join(source, relative));
  const archive = path.join(fixture, 'app.asar');
  assert.ok(runtimeAssetUnpackPatterns.includes('assets/skills/halo-video-subtitles/**'));
  // electron-builder's project-relative file sets differ from raw ASAR's
  // absolute file globs. Exercise the selected directory through unpackDir.
  const unpackDir = path.normalize(runtimeAssetUnpackPatterns[0].replace(/\/\*\*$/, ''));
  await createPackageWithOptions(source, archive, { unpackDir });
  assert.equal(fs.readFileSync(path.join(`${archive}.unpacked`, relative), 'utf8'),
    fs.readFileSync(path.join(root, relative), 'utf8'));
} finally {
  assert.equal(path.dirname(fixture), os.tmpdir());
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5 });
}
console.log('PASS lightweight subtitle catalog, timeline validation, heavy-helper removal and physical ASAR scripts.');
