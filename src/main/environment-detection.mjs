import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WINGET_HELP = 'https://learn.microsoft.com/windows/package-manager/winget/';
const PYTHON_PROBE = 'import json,sys; print(json.dumps({"version":sys.version.split()[0],"path":sys.executable}))';
const PATH_PROBE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @{machine=[Environment]::GetEnvironmentVariable("Path", "Machine"); user=[Environment]::GetEnvironmentVariable("Path", "User")} | ConvertTo-Json -Compress';

/** Small, hidden, bounded probes; never invoke command text through a shell. */
function runCommand(file, args, { env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let complete = false;
    let stdout = '';
    let stderr = '';
    const finish = (result) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const stop = (error) => {
      try { child?.kill(); } catch { /* The process may already have exited. */ }
      finish({ code: -1, error });
    };
    try {
      child = spawn(file, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (complete) return;
        if (stdout.length + stderr.length + chunk.length > 65536) return stop('output-limit');
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        if (complete) return;
        if (stdout.length + stderr.length + chunk.length > 65536) return stop('output-limit');
        stderr += chunk;
      });
      child.once('error', () => finish({ code: -1, error: 'start-failed' }));
      child.once('close', (code) => finish({ code }));
      timer = setTimeout(() => stop('timeout'), timeoutMs);
    } catch {
      finish({ code: -1, error: 'start-failed' });
    }
  });
}

function envValue(env, name) {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return key ? String(env[key] || '') : '';
}

function executableExists(file) {
  if (fs.existsSync(file)) return true;
  // App Execution Aliases (notably winget.exe) can be launched even though
  // stat/existsSync follows their reparse point and fails with EACCES.
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

function dependencies(options) {
  return {
    platform: options.platform || process.platform,
    env: options.env || process.env,
    run: options.run || runCommand,
    exists: options.exists || executableExists,
    excludedDirectories: options.excludedDirectories || [],
  };
}

function expandWindowsPath(value, env) {
  return value.replace(/%([^%]+)%/g, (match, name) => envValue(env, name) || match);
}

function pathKey(value, platform) {
  const cleaned = value.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  return platform === 'win32' ? cleaned.replace(/\//g, '\\').toLowerCase() : cleaned;
}

async function persistedWindowsPath(deps) {
  const systemRoot = envValue(deps.env, 'SystemRoot') || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!deps.exists(powershell)) return [];
  try {
    const result = await deps.run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PATH_PROBE], { env: deps.env });
    if (result.code !== 0) return [];
    const value = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    return [value.machine, value.user].filter((entry) => typeof entry === 'string');
  } catch {
    return [];
  }
}

/** Refresh this process only; installation owns persistent/global PATH changes. */
export async function refreshProcessPath(options = {}) {
  const deps = dependencies(options);
  if (deps.platform !== 'win32') return deps.env.PATH || '';
  const delimiter = ';';
  const current = envValue(deps.env, 'PATH');
  const persisted = deps.platform === 'win32' ? await persistedWindowsPath(deps) : [];
  const seen = new Set();
  const entries = [];
  for (const value of [current, ...persisted]) {
    for (let entry of value.split(delimiter)) {
      entry = entry.trim().replace(/^"(.*)"$/, '$1');
      if (deps.platform === 'win32') entry = expandWindowsPath(entry, deps.env);
      const key = pathKey(entry, deps.platform);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  const keys = Object.keys(deps.env).filter((key) => key.toLowerCase() === 'path');
  const targetKey = keys[0] || (deps.platform === 'win32' ? 'Path' : 'PATH');
  for (const key of keys) if (key !== targetKey) delete deps.env[key];
  deps.env[targetKey] = entries.join(delimiter);
  return deps.env[targetKey];
}

function privateRuntime(file, deps) {
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  // Bundled app/agent runtimes are not tools installed into the user's shell.
  if (/\/(?:\.codex|node_modules)\//.test(normalized) || /\/resources\/app\.asar(?:\.unpacked)?\//.test(normalized)) return true;
  const key = pathKey(file, deps.platform);
  return deps.excludedDirectories.some((dir) => {
    const prefix = pathKey(dir, deps.platform);
    const separator = deps.platform === 'win32' ? '\\' : '/';
    return key === prefix || key.startsWith(prefix + separator);
  });
}

function executableCandidates(names, deps) {
  const searchPath = deps.platform === 'win32' ? envValue(deps.env, 'PATH') : (deps.env.PATH || '');
  const paths = searchPath.split(deps.platform === 'win32' ? ';' : ':');
  const api = deps.platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set();
  const candidates = [];
  for (const directory of paths) {
    // Do not execute a project-local binary through a relative/empty PATH entry.
    if (!api.isAbsolute(directory)) continue;
    for (const name of names) {
      const file = api.join(directory, deps.platform === 'win32' ? `${name}.exe` : name);
      const key = pathKey(file, deps.platform);
      if (seen.has(key) || privateRuntime(file, deps) || !deps.exists(file)) continue;
      seen.add(key);
      // These aliases open Microsoft Store instead of running an interpreter.
      if (deps.platform === 'win32' && /[\\/]Microsoft[\\/]WindowsApps[\\/]python[\d.]*\.exe$/i.test(file)) continue;
      candidates.push(file);
    }
  }
  return candidates;
}

async function probe(file, args, deps) {
  try {
    return await deps.run(file, args, { env: deps.env });
  } catch {
    return { code: -1, stdout: '', stderr: '', error: 'start-failed' };
  }
}

async function pythonStatus(deps) {
  const names = deps.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  const candidates = executableCandidates(names, deps).map((file) => ({ file, args: ['-I', '-c', PYTHON_PROBE] }));
  if (deps.platform === 'win32') {
    candidates.push(...executableCandidates(['py'], deps).map((file) => ({ file, args: ['-3', '-I', '-c', PYTHON_PROBE] })));
  }
  for (const { file, args } of candidates) {
    const result = await probe(file, args, deps);
    if (result.code !== 0) continue;
    try {
      const value = JSON.parse(result.stdout.trim());
      const api = deps.platform === 'win32' ? path.win32 : path.posix;
      if (!/^3\.\d+\.\d+(?:[\w.+-]*)$/.test(value.version) || !api.isAbsolute(value.path) || !deps.exists(value.path) || privateRuntime(value.path, deps)) continue;
      return { id: 'python', name: 'Python', installed: true, version: value.version, path: value.path };
    } catch { /* An alias or another executable did not return a Python result. */ }
  }
  return { id: 'python', name: 'Python', installed: false, version: null, path: null,
    problem: candidates.length ? 'broken' : 'missing',
    error: candidates.length ? '检测到 Python 命令，但无法正常运行；请检查安装或 PATH。' : '未在全局 PATH 中找到 Python。' };
}

async function versionStatus(id, name, names, pattern, deps) {
  const candidates = executableCandidates(names, deps);
  for (const file of candidates) {
    const result = await probe(file, ['--version'], deps);
    if (result.code !== 0) continue;
    const version = String(result.stdout || '').trim().match(pattern)?.[1];
    if (version) return { id, name, installed: true, version, path: file };
  }
  return { id, name, installed: false, version: null, path: null,
    problem: candidates.length ? 'broken' : 'missing',
    error: candidates.length ? `检测到 ${name} 命令，但无法正常运行；请检查安装或 PATH。` : `未在全局 PATH 中找到 ${name}。` };
}

/** Detect only locally installed tools, independently of Electron's built-in Node. */
export async function detectEnvironment(options = {}) {
  const deps = dependencies(options);
  // Detection must not change the caller's process or persisted environment.
  deps.env = { ...deps.env };
  await refreshProcessPath(deps);
  const [python, node, git, winget] = await Promise.all([
    pythonStatus(deps),
    versionStatus('node', 'Node.js', ['node'], /^v(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/, deps),
    versionStatus('git', 'Git', ['git'], /^git version (\d+(?:\.\d+)+[\w.+-]*)$/, deps),
    deps.platform === 'win32' ? versionStatus('winget', 'WinGet', ['winget'], /^v?(\d+(?:\.\d+)+[\w.+-]*)$/, deps) : null,
  ]);
  return {
    platform: deps.platform,
    installer: {
      name: 'WinGet', available: Boolean(winget?.installed), path: winget?.path || null, version: winget?.version || null,
      ...(!winget?.installed ? { error: deps.platform === 'win32' ? '未找到可用的 WinGet，请先安装或更新 Microsoft 应用安装程序。' : '一键全局安装目前支持 Windows；请通过系统包管理器安装所需工具。', helpUrl: WINGET_HELP } : {}),
    },
    tools: [python, node, git],
    updatedAt: new Date().toISOString(),
  };
}
