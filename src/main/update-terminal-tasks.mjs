import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run = promisify(execFile);

export async function terminalUpdateTasks(sessions, {platform = process.platform, query = run} = {}) {
  const roots = [...sessions.values()].filter(rec => Number.isInteger(rec.child.pid) && rec.child.pid > 0);
  if (!roots.length) return [];
  let parents;
  if (platform === 'win32') {
    const ids = roots.map(rec => rec.child.pid).join(',');
    const {stdout} = await query('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',
      `$roots=@(${ids}); @(Get-CimInstance Win32_Process | Where-Object { $roots -contains $_.ParentProcessId } | Select-Object -ExpandProperty ParentProcessId) | ConvertTo-Json -Compress`],
    {windowsHide:true, timeout:8000, maxBuffer:65536});
    parents = stdout.trim() ? [JSON.parse(stdout)].flat() : [];
  } else {
    const {stdout} = await query('ps', ['-eo','ppid='], {timeout:8000,maxBuffer:1024*1024});
    parents = stdout.trim().split(/\s+/).map(Number);
  }
  const running = new Set(parents);
  return roots.filter(rec => running.has(rec.child.pid)).map(rec => ({kind:'terminal',name:`终端命令 · ${rec.cwd}`}));
}
