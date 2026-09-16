'use strict';
const fs = require('node:fs');
const path = require('node:path');
const prepareInstaller = require('./prepare-installer.cjs');

// Physical CLI/worker entrypoints need their whole dependency closure beside
// them. Pure JavaScript used from app.asar can stay archived to avoid thousands
// of individual installer writes. Do not turn this into a native-extension-only
// list: Pi/Wrangler use external processes, workers and dynamic import loaders.
const runtimeRoots = ['@earendil-works/pi-coding-agent', 'wrangler', 'node-pty', '@napi-rs/canvas', 'sharp', 'ssh2'];
function runtimeUnpackPatterns(project) {
  const packages = new Set();
  const names = new Set();
  function resolvePackage(name, from) {
    let current = from;
    while (current === project || current.startsWith(project + path.sep)) {
      const candidate = path.join(current, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (current === project) break;
      current = path.dirname(current);
    }
    return null;
  }
  function include(dir) {
    if (packages.has(dir)) return;
    packages.add(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    names.add(manifest.name);
    const optional = new Set(Object.keys(manifest.optionalDependencies || {}));
    for (const name of new Set([...Object.keys(manifest.dependencies || {}), ...optional, ...Object.keys(manifest.peerDependencies || {})])) {
      const dependency = resolvePackage(name, dir);
      if (dependency) include(dependency);
      else if (manifest.dependencies?.[name] && !optional.has(name)) throw Error(`Missing runtime dependency ${manifest.name} -> ${name}`);
    }
  }
  for (const name of runtimeRoots) {
    const dir = resolvePackage(name, project);
    if (!dir) throw Error(`Missing packaged runtime ${name}`);
    include(dir);
  }
  // electron-builder hoists production dependencies while collecting them.
  // The physical source path (for example Pi's nested minimatch 10) can become
  // node_modules/minimatch in the package. Match every installed location of
  // each required package name, including nested versions, after that hoist.
  return [...names].sort().flatMap(name => [
    `node_modules/${name}/**`,
    `node_modules/**/node_modules/${name}/**`,
  ]);
}
module.exports = function preparePackage(context) {
  const project = path.resolve(context.packager.projectDir);
  prepareInstaller();
  const patterns = runtimeUnpackPatterns(project);
  context.packager.config.asarUnpack = patterns;
  fs.writeFileSync(path.join(project, 'build/generated/runtime-unpack.json'), JSON.stringify({ roots: runtimeRoots, patterns }, null, 2) + '\n');
  console.log(`Preserving ${patterns.length} runtime package roots outside ASAR; other dependencies stay archived.`);
};
module.exports.runtimeUnpackPatterns = runtimeUnpackPatterns;
