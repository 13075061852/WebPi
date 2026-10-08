import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { videoResponse } from './video-preview.mjs';
import { writeVideoJSON } from './video-settings.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav' };
const DEFAULT_PROFILE = { photoId: null, photoIds: [], voiceId: null };
const DEFAULT_DRAFT = { script: '', scene: '', action: '', resolution: '768P', ratio: '16:9' };
const within = (directory, file) => {
  const relative = path.relative(directory, file);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function assetMime(kind, extension, buffer) {
  if (kind === 'photo') {
    if (['.jpg', '.jpeg'].includes(extension) && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (extension === '.png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (extension === '.webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    throw Error('照片须为 JPG、PNG 或 WEBP');
  }
  if (extension === '.wav' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (extension === '.m4a' && buffer.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (extension === '.mp3' && (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) !== 0 && (buffer[1] & 0x18) !== 0x08 && (buffer[2] & 0xf0) !== 0xf0 && (buffer[2] & 0x0c) !== 0x0c))) return 'audio/mpeg';
  throw Error('录音须为 MP3、M4A 或 WAV');
}

async function readAsset(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw Error('素材须为文件，最大 20 MB');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_BYTES) throw Error('素材超过 20 MB');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (!total) throw Error('素材文件为空');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

export class DigitalHuman {
  constructor(directory, { readImage } = {}) {
    this.directory = path.resolve(directory);
    this.assetsDirectory = path.join(this.directory, 'assets');
    this.file = path.join(this.directory, 'draft.json');
    this.readImage = readImage;
  }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, assets: [], profile: { ...DEFAULT_PROFILE }, draft: { ...DEFAULT_DRAFT } };
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.assets) || !data.draft || typeof data.draft !== 'object' || Array.isArray(data.draft)) throw Error();
      const seen = new Set();
      for (const asset of data.assets) {
        if (!asset || !UUID.test(asset.id) || seen.has(asset.id) || !['photo', 'voice'].includes(asset.kind) || !MIME_EXT[asset.mime] || !asset.mime.startsWith(asset.kind === 'photo' ? 'image/' : 'audio/')) throw Error();
        seen.add(asset.id);
      }
      // Earlier local drafts also contained the reusable portrait/voice choices.
      // Migrate in memory; the next normal save persists the separated structure.
      const profile = Object.hasOwn(data, 'profile') ? data.profile : data.draft;
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error();
      data.profile = Object.fromEntries(Object.keys(DEFAULT_PROFILE).map(key => [key, profile[key] ?? null]));
      data.profile.photoIds = Array.isArray(profile.photoIds) ? [...new Set(profile.photoIds)] : profile.photoId ? [profile.photoId] : [];
      data.profile.photoId = data.profile.photoIds[0] || null;
      data.draft = Object.fromEntries(Object.entries(DEFAULT_DRAFT).map(([key, value]) => [key, data.draft[key] ?? value]));
      return data;
    } catch { throw Error('数字人草稿无法读取'); }
  }
  assetFile(asset) {
    const file = path.join(this.assetsDirectory, `${asset.id}${MIME_EXT[asset.mime]}`);
    if (!UUID.test(asset.id) || !MIME_EXT[asset.mime] || !within(this.assetsDirectory, file)) throw Error('无效的素材');
    return file;
  }
  storageDirectory() {
    const base = fs.realpathSync(this.directory), storage = fs.realpathSync(this.assetsDirectory);
    if (!within(base, storage)) throw Error('素材目录超出本地草稿目录');
    return storage;
  }
  inspect(asset) {
    const file = this.assetFile(asset);
    try {
      const stat = fs.statSync(file);
      const base = this.storageDirectory(), target = fs.realpathSync(file);
      if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES || !within(base, target)) return { exists: stat.isFile(), available: false, status: 'unavailable' };
      fs.accessSync(file, fs.constants.R_OK);
      return { exists: true, available: asset.kind === 'photo' || asset.quality === 'ready', status: asset.kind === 'voice' && asset.quality !== 'ready' ? asset.quality : 'ready' };
    } catch (error) { return { exists: false, available: false, status: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'deleted' : 'unavailable' }; }
  }
  publicAsset(asset) {
    return { id: asset.id, kind: asset.kind, name: asset.name, mime: asset.mime, bytes: asset.bytes,
      width: asset.width ?? null, height: asset.height ?? null, duration: asset.duration ?? null,
      quality: asset.quality, createdAt: asset.createdAt, previewURL: `halo-preview://digital-human/${asset.id}`, ...this.inspect(asset) };
  }
  state() {
    const data = this.read();
    return { photos: data.assets.filter(asset => asset.kind === 'photo').map(asset => this.publicAsset(asset)),
      voices: data.assets.filter(asset => asset.kind === 'voice').map(asset => this.publicAsset(asset)), profile: { ...data.profile }, draft: { ...data.draft }, connected: false };
  }
  async importAsset(kind, filePath) {
    if (!['photo', 'voice'].includes(kind) || typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw Error('无效的素材路径');
    const buffer = await readAsset(filePath);
    return this.storeAsset(kind, path.basename(filePath), buffer);
  }
  async importRecording(input) {
    if (!(input instanceof Uint8Array) || input.byteLength < 44 || input.byteLength > MAX_BYTES) throw Error('录音数据无效或超过 20 MB');
    const buffer = Buffer.from(input);
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE'
      || buffer.toString('ascii', 12, 16) !== 'fmt ' || buffer.readUInt32LE(16) !== 16
      || buffer.readUInt16LE(20) !== 1 || buffer.readUInt16LE(22) !== 1 || buffer.readUInt16LE(34) !== 16
      || buffer.toString('ascii', 36, 40) !== 'data' || buffer.readUInt32LE(40) !== buffer.length - 44
      || buffer.readUInt32LE(4) !== buffer.length - 8 || buffer.readUInt16LE(32) !== 2) throw Error('录音 WAV 格式无效');
    const rate = buffer.readUInt32LE(24), duration = (buffer.length - 44) / (rate * 2);
    if ((buffer.length - 44) % 2 !== 0 || rate < 8000 || rate > 48000 || buffer.readUInt32LE(28) !== rate * 2 || duration < 10 || duration > 300) throw Error('录音时长须为 10 秒至 5 分钟');
    return this.storeAsset('voice', `录音-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`, buffer);
  }
  async storeAsset(kind, name, buffer) {
    const mime = assetMime(kind, path.extname(name).toLowerCase(), buffer);
    const asset = { id: randomUUID(), kind, name: name.slice(0, 160), mime, bytes: buffer.length,
      width: null, height: null, duration: null, quality: kind === 'photo' ? 'ready' : 'unchecked', createdAt: new Date().toISOString() };
    if (kind === 'photo') {
      if (!this.readImage) throw Error('照片验证尚未就绪');
      const dimensions = await this.readImage(buffer);
      const width = dimensions?.width, height = dimensions?.height;
      if (![width, height].every(value => Number.isInteger(value) && value >= 256 && value <= 5760) || width / height < 0.4 || width / height > 2.5) throw Error('照片边长须为 256–5760 像素，宽高比须为 0.4–2.5');
      asset.width = width; asset.height = height;
    }
    const data = this.read();
    fs.mkdirSync(this.assetsDirectory, { recursive: true });
    this.storageDirectory();
    const target = this.assetFile(asset);
    fs.writeFileSync(target, buffer, { flag: 'wx', mode: 0o600 });
    try { data.assets.push(asset); writeVideoJSON(this.file, data); }
    catch (error) { fs.unlinkSync(target); throw error; }
    return { ...this.publicAsset(asset), ...(kind === 'voice' ? { data: buffer.toString('base64') } : {}) };
  }
  assetUpdate(input) {
    const data = this.read();
    const asset = data.assets.find(item => item.id === input?.id);
    if (!asset) throw Error('素材不存在');
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || [...input.name].length > 160 || /[\u0000-\u001f\u007f]/.test(input.name)) throw Error('素材名称需为 1–160 字符');
      asset.name = input.name.trim();
    }
    if (input.duration !== undefined || input.quality !== undefined) {
      if (asset.kind !== 'voice' || !['ready', 'unavailable', 'unchecked'].includes(input.quality)) throw Error('无效的声音检查结果');
      if (input.quality === 'ready') {
        if (!Number.isFinite(input.duration) || input.duration < 10 || input.duration > 300) throw Error('录音时长须为 10 秒至 5 分钟');
        if (!this.inspect(asset).exists) throw Error('录音文件已删除');
        asset.duration = input.duration;
      } else asset.duration = null;
      asset.quality = input.quality;
    }
    writeVideoJSON(this.file, data);
    return this.state();
  }
  profileSave(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('无效的数字人配置');
    const data = this.read(), profile = { ...data.profile };
    for (const [key, kind] of [['photoId', 'photo'], ['voiceId', 'voice']]) {
      if (input[key] === undefined) continue;
      const id = input[key] === '' ? null : input[key];
      if (id !== null && (typeof id !== 'string' || !data.assets.some(asset => asset.id === id && asset.kind === kind))) throw Error('配置素材不存在');
      profile[key] = id;
    }
    if (input.photoIds !== undefined) {
      if (!Array.isArray(input.photoIds) || input.photoIds.length > 9 || new Set(input.photoIds).size !== input.photoIds.length
        || input.photoIds.some(id => typeof id !== 'string' || !data.assets.some(asset => asset.id === id && asset.kind === 'photo'))) throw Error('请选择最多 9 张有效照片');
      profile.photoIds = [...input.photoIds];
    } else if (input.photoId !== undefined) profile.photoIds = profile.photoId ? [profile.photoId] : [];
    profile.photoId = profile.photoIds[0] || null;
    data.profile = profile;
    writeVideoJSON(this.file, data);
    return this.state();
  }
  draftSave(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('无效的数字人草稿');
    const data = this.read(), draft = { ...data.draft };
    for (const [key, limit] of [['script', 5000], ['scene', 1500], ['action', 1500]]) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== 'string' || [...input[key]].length > limit || input[key].includes('\0')) throw Error(`草稿${key === 'script' ? '台词' : key === 'scene' ? '场景' : '动作'}过长或无效`);
      draft[key] = input[key];
    }
    if (input.resolution !== undefined) {
      if (!['768P', '2K'].includes(input.resolution)) throw Error('无效的视频分辨率');
      draft.resolution = input.resolution;
    }
    if (input.ratio !== undefined) {
      if (!['16:9', '9:16', '1:1'].includes(input.ratio)) throw Error('无效的视频比例');
      draft.ratio = input.ratio;
    }
    data.draft = draft;
    writeVideoJSON(this.file, data);
    return this.state();
  }
  assetDelete(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw Error('无效的素材');
    const data = this.read(), asset = data.assets.find(item => item.id === id);
    if (!asset) return this.state();
    if (fs.existsSync(this.assetsDirectory)) this.storageDirectory();
    try { fs.unlinkSync(this.assetFile(asset)); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    data.assets = data.assets.filter(item => item.id !== id);
    for (const key of ['photoId', 'voiceId']) if (data.profile[key] === id) data.profile[key] = null;
    data.profile.photoIds = data.profile.photoIds.filter(value => value !== id);
    data.profile.photoId = data.profile.photoIds[0] || null;
    writeVideoJSON(this.file, data);
    return this.state();
  }
  async response(request) {
    try {
      const url = new URL(request.url), id = url.pathname.slice(1);
      if (url.protocol !== 'halo-preview:' || url.hostname !== 'digital-human' || url.username || url.password || url.port || url.search || url.hash || !UUID.test(id)) return new Response(null, { status: 404 });
      const asset = this.read().assets.find(item => item.id === id);
      if (!asset || !this.inspect(asset).exists) return new Response(null, { status: 404 });
      // Unchecked samples remain previewable so the trusted UI can inspect them.
      const file = this.assetFile(asset);
      const base = this.storageDirectory(), target = fs.realpathSync(file);
      if (!within(base, target)) return new Response(null, { status: 403 });
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) return new Response(null, { status: 413 });
      return videoResponse(request, file, stat.size, asset.mime);
    } catch { return new Response(null, { status: 404 }); }
  }
}
