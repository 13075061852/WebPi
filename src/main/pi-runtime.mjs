import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function bundledEntry() {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  // Workers, native modules and the Electron-as-Node CLI need real files.
  // electron-builder ships the complete production dependency tree unpacked.
  const unpacked = entry.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return fs.existsSync(unpacked) ? unpacked : entry;
}

export function resolvePiEntry() {
  // Explicit developer/test override only; a machine's global Pi never wins
  // over the version pinned and tested with this app.
  const override = process.env.PI_HALO_PI_PATH;
  const entry = override ? path.resolve(override) : bundledEntry();
  if (!fs.existsSync(entry)) throw new Error('Pi 内核文件缺失，请重新安装 Pi Halo');
  return entry;
}

export function resolvePiCli() {
  const cli = path.join(path.dirname(bundledEntry()), 'bundle', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error('Pi 内核命令文件缺失，请重新安装 Pi Halo');
  return cli;
}
