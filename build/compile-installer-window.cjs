'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const source = path.join(__dirname, 'installer-window.c');
const binary = path.join(__dirname, 'installer-window.dll');
const manifest = path.join(__dirname, 'installer-window.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHash = () => crypto.createHash('sha256')
  .update(fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

function verify() {
  const expected = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (expected.sourceSha256 !== sourceHash() || expected.dllSha256 !== hash(binary)) {
    throw new Error('Installer native UI source/binary mismatch. Recompile with build/compile-installer-window.cjs.');
  }
  const data = fs.readFileSync(binary);
  const pe = data.readUInt32LE(0x3c);
  if (data.readUInt16LE(pe + 4) !== 0x14c || data.readUInt32LE(pe) !== 0x4550) {
    throw new Error('Installer native UI must be a Windows x86 DLL.');
  }
}

if (require.main === module) {
  const compiler = process.argv[2];
  if (!compiler) throw new Error('Pass the path to TinyCC 0.9.27 win32 tcc.exe.');
  const version = spawnSync(compiler, ['-v'], { encoding: 'utf8', windowsHide: true });
  if (!/0\.9\.27.*i386|0\.9\.27.*win32/i.test(version.stdout + version.stderr)) {
    throw new Error('Expected TinyCC 0.9.27 targeting Windows x86.');
  }
  const result = spawnSync(compiler, ['-shared', source, '-o', binary, '-luser32', '-lgdi32'],
    { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('Native UI compilation failed.');
  fs.writeFileSync(manifest, JSON.stringify({ compiler: 'TinyCC 0.9.27 win32',
    sourceSha256: sourceHash(), dllSha256: hash(binary) }, null, 2) + '\n');
  // TCC also emits a .def export list; it is an intermediate build product.
  fs.rmSync(path.join(__dirname, 'installer-window.def'), { force: true });
  verify();
  console.log('Verified native installer UI: Windows x86, matching source and DLL.');
}
module.exports = verify;
