import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export async function copyFileToClipboard(file) {
  if (process.platform !== 'win32') throw Error('当前系统暂不支持复制文件');
  const shell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($env:HALO_CLIPBOARD_FILE)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)`;
  await run(shell, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15000, env: { ...process.env, HALO_CLIPBOARD_FILE: file },
  });
}
