import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);

function pngIcon(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // ICO image count follows reserved/type fields.
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

// The taskbar uses the executable's embedded icon, even when BrowserWindow's
// title bar has a custom PNG. Keep the developer executable beside electron.exe
// so Chromium finds the same DLLs and resources. node_modules is ignored by Git.
export async function devElectronExecutable(root) {
  const electronDir = path.join(root, 'node_modules', 'electron', 'dist');
  const source = path.join(electronDir, 'electron.exe');
  const icon = path.join(root, 'assets', 'icon-rounded.png');
  const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  for (const file of [source, icon, rcedit]) if (!fs.existsSync(file)) throw Error(`开发版图标所需文件缺失：${file}`);
  const stem = `Pi-Halo-Dev-${digest(source)}-${digest(icon)}`;
  const target = path.join(electronDir, `${stem}.exe`);
  if (fs.existsSync(target)) return target;
  const png = await sharp(icon).resize(256, 256, { fit: 'cover' }).png().toBuffer();
  const icoFile = path.join(electronDir, `${stem}.ico`);
  const temporary = path.join(electronDir, `${stem}-${process.pid}.exe`);
  try {
    fs.writeFileSync(icoFile, pngIcon(png));
    fs.copyFileSync(source, temporary);
    execFileSync(rcedit, [temporary, '--set-icon', icoFile], { stdio: 'pipe' });
    fs.renameSync(temporary, target);
    return target;
  } catch (error) {
    throw Error(`无法准备开发版图标：${error?.message || error}`);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
