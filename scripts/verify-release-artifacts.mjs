import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { blake2b } from '@noble/hashes/blake2.js';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = data => createHash('sha256').update(data).digest('hex');
async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const part of fs.createReadStream(file)) digest.update(part);
  return digest.digest('hex');
}
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.isFile() && !/\.(?:map|d\.(?:ts|mts|cts))$/.test(file) ? [file] : [];
  });
}

// Check the actual bytes every differential-download chunk identifies. A valid
// gzip/JSON file alone cannot establish that a blockmap belongs to this EXE.
async function verifyBlockmap(executable, blockmap, expected) {
  const map = JSON.parse(gunzipSync(fs.readFileSync(blockmap)));
  assert.equal(map.version, '2', 'Unsupported blockmap version');
  assert.equal(map.files?.length, 1, 'NSIS blockmap must describe the whole installer');
  const chunks = map.files[0];
  assert.equal(chunks.offset, 0);
  assert.equal(chunks.sizes?.length, chunks.checksums?.length);
  assert.ok(chunks.sizes.length > 0);
  const sha512 = createHash('sha512'), sha256 = createHash('sha256');
  const handle = await fs.promises.open(executable, 'r');
  let position = 0;
  try {
    for (let index = 0; index < chunks.sizes.length; index++) {
      const size = chunks.sizes[index];
      assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 32768, `Invalid chunk ${index} size`);
      const buffer = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const { bytesRead } = await handle.read(buffer, read, size - read, position + read);
        assert.ok(bytesRead > 0, `Installer ends inside blockmap chunk ${index}`);
        read += bytesRead;
      }
      const checksum = Buffer.from(blake2b(buffer, { dkLen: 18 })).toString('base64');
      assert.equal(checksum, chunks.checksums[index], `Blockmap chunk ${index} does not match the EXE`);
      sha512.update(buffer); sha256.update(buffer);
      position += size;
    }
  } finally { await handle.close(); }
  assert.equal(position, fs.statSync(executable).size, 'Blockmap must cover every installer byte');
  assert.equal(position, expected.size, 'latest.yml size must match the installer');
  assert.equal(sha512.digest('base64'), expected.sha512, 'latest.yml SHA-512 must match the installer');
  return { sha256: sha256.digest('hex'), size: position, chunks: chunks.sizes.length };
}

export async function verifyReleaseArtifacts({ directory = path.join(root, 'dist'), tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined, stageDirectory = process.env.HALO_PACKAGE_STAGE } = {}) {
  assert.equal(process.platform, 'win32', 'Verify the Windows installer on Windows');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (tag) assert.equal(tag, `v${manifest.version}`, 'Release tag must match source version');
  const updateFile = path.join(directory, 'latest.yml');
  const update = parse(fs.readFileSync(updateFile, 'utf8'));
  assert.equal(update.version, manifest.version, 'Update manifest must match source version');
  assert.equal(update.files?.length, 1, 'Expected one Windows x64 installer');
  const entry = update.files[0];
  assert.match(entry.url, /^[A-Za-z0-9][A-Za-z0-9 ._-]*\.exe$/, 'Installer URL must be a local safe filename');
  assert.equal(path.basename(entry.url), entry.url);
  assert.equal(update.path, entry.url, 'Both update paths must name the same asset');
  assert.equal(update.sha512, entry.sha512, 'Both update hashes must agree');
  assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0);
  assert.ok(Number.isFinite(Date.parse(update.releaseDate)), 'Update release date is invalid');
  const executable = path.join(directory, entry.url), blockmap = `${executable}.blockmap`;
  assert.ok(fs.statSync(executable).isFile());
  assert.ok(fs.statSync(blockmap).isFile());
  const result = await verifyBlockmap(executable, blockmap, entry);
  console.log(`PASS installer SHA-512, size and ${result.chunks} differential chunks`);

  // Extract only the application archive from the installer. Never run the
  // installer, alter the registered installation, or read a user's account data.
  const tempRoot = path.join(root, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempRoot, 'release-verify-'));
  const sevenZip = path.join(path.dirname(require.resolve('electron-winstaller/package.json')), 'vendor', '7z.exe');
  const extract = args => run(sevenZip, ['x', '-y', '-bso0', '-bsp0', ...args], { windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  try {
    await extract([executable, '-o' + temp, '$PLUGINSDIR\\app-64.7z']);
    const payload = path.join(temp, '$PLUGINSDIR', 'app-64.7z');
    assert.ok(fs.existsSync(payload), 'Installer application payload is missing');
    const payloadDirectory = stageDirectory ? path.resolve(stageDirectory) : path.join(temp, 'payload');
    if (stageDirectory) {
      const relative = path.relative(root, payloadDirectory);
      assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Stage the release outside the checkout to prevent dependency fallback');
      assert.ok(!fs.existsSync(payloadDirectory), 'Use a new empty staging path, never an installed app directory');
      fs.mkdirSync(payloadDirectory, { recursive: true });
    }
    await extract([payload, '-o' + payloadDirectory, ...(stageDirectory ? [] : ['resources\\app.asar'])]);
    const archive = path.join(payloadDirectory, 'resources', 'app.asar');
    assert.ok(fs.existsSync(archive), 'Installed application ASAR is missing');
    const builtArchive = path.join(directory, 'win-unpacked', 'resources', 'app.asar');
    assert.equal(await hashFile(archive), await hashFile(builtArchive), 'Installer payload differs from the tested unpacked app');
    const allowedRoots = new Set(['src', 'assets', 'node_modules', 'package.json']);
    const entries = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
    for (const file of entries) assert.ok(allowedRoots.has(file.split('/')[0]), `Unexpected packaged path: ${file}`);
    const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
    assert.equal(packaged.version, manifest.version, 'Installer contains stale application version');
    assert.equal(packaged.main, manifest.main, 'Installer entrypoint differs from source');
    assert.ok(entries.includes(manifest.main), 'Installer main entrypoint is missing');
    let checkedSources = 0;
    for (const file of [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'assets'))]) {
      const relative = path.relative(root, file).replaceAll(path.sep, '/');
      assert.equal(hash(asar.extractFile(archive, path.normalize(relative))), hash(fs.readFileSync(file)), `Installer contains stale source: ${relative}`);
      checkedSources++;
    }
    const report = {
      version: manifest.version, verifiedAt: new Date().toISOString(),
      executable: { file: entry.url, ...result },
      blockmap: { file: path.basename(blockmap), sha256: await hashFile(blockmap) },
      latest: { file: 'latest.yml', sha256: await hashFile(updateFile) },
      archive: { sha256: await hashFile(archive), entries: entries.length, checkedSources },
      assets: [entry.url, path.basename(blockmap), 'latest.yml'],
      ...(stageDirectory ? { stagedExe: path.join(payloadDirectory, 'Pi Halo.exe') } : {}),
    };
    fs.mkdirSync(path.join(root, 'test', 'results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'results', 'release-artifacts.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`PASS installer payload version ${manifest.version}, allowed archive roots and ${checkedSources} current source files`);
    return report;
  } finally {
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(tempRoot));
    assert.ok(path.basename(resolved).startsWith('release-verify-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyReleaseArtifacts(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
