import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Reviewed upstream manifests, 2026-10-08. Keep URL and digest updates together.
// https://github.com/microsoft/winget-pkgs/tree/master/manifests/p/Python/Python/3/14/3.14.7
// https://github.com/microsoft/winget-pkgs/tree/master/manifests/o/OpenJS/NodeJS/LTS/24.20.0
// https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Git/Git/2.55.0
export const PINNED_INSTALLERS = Object.freeze({
  python: Object.freeze({ name: 'Python', version: '3.14.7', artifacts: Object.freeze({
    x64: Object.freeze({ url: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-amd64.exe', sha256: '9d9eb2709ef81bf5cd30db3c2096bdbc4ea10087c22e62f27d356b36f6ae9649' }),
    arm64: Object.freeze({ url: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-arm64.exe', sha256: '9a3fe120cc81bc2cb099550f794d8356811f96a86c7f438519243c3485db928d' }),
  }) }),
  node: Object.freeze({ name: 'Node.js', version: '24.20.0', artifacts: Object.freeze({
    x64: Object.freeze({ url: 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip', sha256: '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba' }),
    arm64: Object.freeze({ url: 'https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-arm64.zip', sha256: '31c6799744de8a54601643098040c68c3697e56c94e407d61d0e5fa5f34191d7' }),
  }) }),
  git: Object.freeze({ name: 'Git', version: '2.55.0', artifacts: Object.freeze({
    x64: Object.freeze({ url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.1/Git-2.55.0-64-bit.exe', sha256: '0c66e4a5875da5a74f9754386de7555ba301503b03bbdcdbafa69dc6464e548d' }),
    arm64: Object.freeze({ url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.1/Git-2.55.0-arm64.exe', sha256: '1c28f00262df9e2721036492d5e206862420325516a9a074d3fec1b9f44431d8' }),
  }) }),
});

const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(['www.python.org', 'python.org', 'nodejs.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const clean = value => String(value || '').replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://***@').slice(-3000);
const envValue = (env, name) => String(env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())] || '');
const powershell = env => path.win32.join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const encodedCommand = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n' + script, 'utf16le').toString('base64')];
const jsonLiteral = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString('base64')}')) | ConvertFrom-Json`;
const integrityError = message => Object.assign(Error(message), { integrityFailure: true });

export function officialInstallAvailable({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const local = envValue(env, 'LOCALAPPDATA');
  return platform === 'win32' && ['x64', 'arm64'].includes(arch) && path.win32.isAbsolute(local) && !/[;\r\n\0]/.test(local);
}

function trustedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) throw Error('安装包下载地址不在官方来源列表中');
  return url.href;
}

/** Streaming download; redirects stay on official delivery hosts and SHA-256 is mandatory. */
export async function downloadVerifiedArtifact(artifact, destination, { fetcher = globalThis.fetch, onOutput = () => {}, files = fs, timeout = 10 * 60 * 1000 } = {}) {
  if (!/^[a-f\d]{64}$/i.test(artifact.sha256)) throw integrityError('缺少安装包 SHA-256 校验值');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let handle;
  let reader;
  let created = false;
  let response;
  try {
    let url = trustedURL(artifact.url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetcher(url, { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw Error('官方下载重定向次数过多');
      url = trustedURL(new URL(location, url).href);
    }
    if (!response?.ok) throw Error(`官方下载失败（HTTP ${response?.status || '未知'}）`);
    if (response.url) trustedURL(response.url);
    const expectedLength = Number(response.headers.get('content-length')) || 0;
    if (expectedLength > MAX_DOWNLOAD_BYTES) throw integrityError('安装包超过允许大小');
    if (!response.body?.getReader) throw integrityError('安装包下载内容为空');
    reader = response.body.getReader();
    handle = await files.open(destination, 'wx');
    created = true;
    const digest = createHash('sha256');
    let received = 0;
    let lastOutput = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) throw integrityError('安装包超过允许大小');
      digest.update(chunk.value);
      await handle.writeFile(chunk.value);
      if (Date.now() - lastOutput >= 1000) {
        const total = expectedLength ? ` / ${(expectedLength / 1048576).toFixed(1)} MB` : ' MB';
        onOutput(`正在下载官方安装包：${(received / 1048576).toFixed(1)}${total}`);
        lastOutput = Date.now();
      }
    }
    if (!received || (expectedLength && expectedLength !== received)) throw integrityError('安装包下载不完整，请检查网络后重试');
    if (digest.digest('hex') !== artifact.sha256.toLowerCase()) throw integrityError('安装包 SHA-256 校验失败，已停止配置');
    onOutput('官方安装包 SHA-256 校验通过');
    return destination;
  } catch (error) {
    await reader?.cancel().catch(() => {});
    if (!reader) await response?.body?.cancel().catch(() => {});
    await handle?.close().catch(() => {});
    handle = null;
    if (created) await files.unlink(destination).catch(() => {});
    throw Object.assign(Error(controller.signal.aborted ? '官方下载超时，请检查网络或代理后重试' : clean(error.message)),
      { ...(error.integrityFailure ? { integrityFailure: true } : {}), ...(controller.signal.aborted ? { timedOut: true } : {}) });
  } finally {
    clearTimeout(timer);
    await handle?.close().catch(() => {});
  }
}

/** Append only verified directories; preserve the user's raw PATH and registry value type. */
export async function ensureUserPath(directories, { run, env = process.env, onOutput = () => {}, files = fs } = {}) {
  try {
    if (typeof run !== 'function') throw Error('缺少环境配置执行器');
    if (!Array.isArray(directories)) throw Error('环境目录无效');
    const normalized = [...new Set(directories.map(value => String(value).replace(/[\\/]+$/, '')))];
    for (const directory of normalized) {
      if (!path.win32.isAbsolute(directory) || /[;\r\n\0]/.test(directory) || !(await files.stat(directory)).isDirectory()) throw Error('环境目录不存在或格式无效');
    }
    if (!normalized.length) return { code: 0, output: '' };
    const script = `$ErrorActionPreference = 'Stop'
$paths = @(${jsonLiteral(normalized)})
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
  $entries = @($raw -split ';' | Where-Object { $_ })
  $next = $raw
  $changed = $false
  foreach ($directory in $paths) {
    $found = $false
    foreach ($entry in $entries) {
      if ([Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"')).TrimEnd('\\','/') -ieq $directory) { $found = $true; break }
    }
    if (!$found) {
      $entries += $directory
      if ($next -and !$next.EndsWith(';')) { $next += ';' }
      $next += $directory
      $changed = $true
    }
  }
  if ($changed) {
    if ($next.Length -ge 32767) { throw 'User PATH is too long' }
    $key.SetValue('Path', $next, $kind)
  }
} finally { $key.Dispose() }
# Notify Explorer so subsequently opened terminals inherit the new user PATH.
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HaloEnvironmentBroadcast { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result); }'
  $broadcastResult = [UIntPtr]::Zero
  [void][HaloEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$broadcastResult)
} catch { }
Write-Output 'USER_PATH_UPDATED'`;
    const result = await run(powershell(env), encodedCommand(script), { env, timeout: 30000 });
    if (result.code !== 0) return { ...result, error: `更新当前用户 PATH 失败。${clean(result.error || result.output)}` };
    const keys = Object.keys(env).filter(key => key.toLowerCase() === 'path');
    const target = keys[0] || 'Path';
    const entries = envValue(env, 'PATH').split(';').filter(Boolean);
    for (const directory of normalized) if (!entries.some(entry => entry.replace(/[\\/]+$/, '').toLowerCase() === directory.toLowerCase())) entries.push(directory);
    for (const key of keys) if (key !== target) delete env[key];
    env[target] = entries.join(';');
    onOutput('已更新当前用户 PATH');
    return { code: 0, output: '已更新当前用户 PATH' };
  } catch (error) { return { code: -1, error: clean(error.message), output: '' }; }
}

function assertOwnedChild(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('环境安装目录越界');
}

async function safeRemove(root, target, files) {
  assertOwnedChild(root, target);
  // Do not follow a replaced directory junction during cleanup.
  const stat = await files.lstat(target).catch(() => null);
  if (stat && !stat.isSymbolicLink()) await files.rm(target, { recursive: true, force: true });
}

export async function installOfficialTool(id, {
  run, onOutput = () => {}, fetcher = globalThis.fetch, env = process.env,
  arch = process.arch, platform = process.platform, files = fs, download = downloadVerifiedArtifact,
} = {}) {
  let staging;
  let root;
  try {
    if (!Object.hasOwn(PINNED_INSTALLERS, id)) throw Error('不支持的环境');
    if (!officialInstallAvailable({ env, arch, platform })) throw Error('官方自动配置支持 Windows x64 / ARM64，并需要有效的用户应用目录');
    if (typeof run !== 'function') throw Error('缺少环境配置执行器');
    const metadata = PINNED_INSTALLERS[id];
    const artifact = metadata.artifacts[arch];
    root = path.join(envValue(env, 'LOCALAPPDATA'), 'Pi Halo', 'environment');
    await files.mkdir(root, { recursive: true });
    if ((await files.lstat(root)).isSymbolicLink()) throw Error('环境安装目录不能是目录链接');
    staging = await files.mkdtemp(path.join(root, '.install-'));
    assertOwnedChild(root, staging);
    const filename = path.basename(new URL(artifact.url).pathname);
    const archive = path.join(staging, filename);
    onOutput(`正在从官方来源下载 ${metadata.name} ${metadata.version}（当前用户安装）…`);
    await download(artifact, archive, { fetcher, onOutput, files });
    if (id !== 'node') {
      // Both full installers register a regular user installation and persist PATH themselves.
      const args = id === 'python'
        ? ['/quiet', '/norestart', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=0', 'Include_test=0']
        : ['/CURRENTUSER', '/VERYSILENT', '/NORESTART', '/SP-', '/NOCANCEL', '/SUPPRESSMSGBOXES', '/NOCLOSEAPPLICATIONS', '/o:PathOption=Cmd'];
      onOutput(`正在安装 ${metadata.name}，请稍候…`);
      const result = await run(archive, args, { onOutput, env });
      const code = result.code >>> 0;
      return { ...result, output: clean(result.output), error: result.error && clean(result.error),
        ...((id === 'git' ? [2, 5] : [1602, 0x80070642]).includes(code) ? { cancelled: true } : {}),
        ...([3010, 1641, 0x80070bc2].includes(code) ? { rebootRequired: true } : {}) };
    }

    const folder = `node-v${metadata.version}-win-${arch}`;
    const target = path.join(root, folder);
    assertOwnedChild(root, target);
    const unpacked = path.join(staging, 'unpacked');
    const extractScript = `$ErrorActionPreference = 'Stop'
$options = ${jsonLiteral({ archive, unpacked })}
Expand-Archive -LiteralPath $options.archive -DestinationPath $options.unpacked
Write-Output 'NODE_ARCHIVE_EXTRACTED'`;
    onOutput('正在解压 Node.js…');
    const extracted = await run(powershell(env), encodedCommand(extractScript), { env, timeout: 3 * 60 * 1000 });
    if (extracted.code !== 0) return { ...extracted, error: `Node.js 解压失败。${clean(extracted.error || extracted.output)}` };
    const candidate = path.join(unpacked, folder);
    for (const name of ['node.exe', 'npm.cmd', 'npx.cmd']) if (!(await files.stat(path.join(candidate, name))).isFile()) throw Error(`Node.js 安装包缺少 ${name}`);
    const probe = await run(path.join(candidate, 'node.exe'), ['--version'], { env, timeout: 15000 });
    if (probe.code !== 0 || String(probe.output || probe.stdout || '').trim() !== `v${metadata.version}`) throw Error(`Node.js 无法在此系统上运行。${clean(probe.error || probe.output)}`);
    const existing = await files.lstat(target).catch(() => null);
    if (existing) {
      // Never replace or recursively delete an existing runtime: it may be in use.
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw Error('Node.js 目标目录已存在且不可用');
      for (const name of ['npm.cmd', 'npx.cmd']) if (!(await files.stat(path.join(target, name))).isFile()) throw Error('已有 Node.js 目录不完整，请移走该目录后重试');
      const previous = await run(path.join(target, 'node.exe'), ['--version'], { env, timeout: 15000 });
      if (previous.code !== 0 || String(previous.output || previous.stdout || '').trim() !== `v${metadata.version}`) throw Error('已有 Node.js 目录无法运行，请移走该目录后重试');
    } else await files.rename(candidate, target);
    return await ensureUserPath([target], { run, env, onOutput, files });
  } catch (error) { return { code: -1, error: clean(error.message), output: '',
    ...(error.integrityFailure ? { integrityFailure: true } : {}), ...(error.timedOut ? { timedOut: true } : {}) }; }
  finally {
    if (staging) await safeRemove(root, staging, files).catch(() => {});
  }
}
