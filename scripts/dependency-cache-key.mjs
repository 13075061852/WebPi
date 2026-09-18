import fs from 'node:fs';
import {createHash} from 'node:crypto';
// Release version bumps do not change installed dependencies or native binaries.
export function dependencyKey(lock, manifest, runtime = `${process.platform}-${process.arch}-${process.version}`) {
  const normalized = structuredClone(lock);
  delete normalized.version;
  if (normalized.packages?.['']) delete normalized.packages[''].version;
  const hooks = Object.fromEntries(['preinstall','install','postinstall','prepare'].map(key=>[key,manifest.scripts?.[key] || '']));
  return `deps-v1-${runtime}-${createHash('sha256').update(JSON.stringify([normalized,hooks])).digest('hex')}`;
}
if (process.argv[1]?.endsWith('dependency-cache-key.mjs')) {
  const key=dependencyKey(JSON.parse(fs.readFileSync('package-lock.json')),JSON.parse(fs.readFileSync('package.json')));
  if(process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,`key=${key}\n`);
  console.log(key);
}
