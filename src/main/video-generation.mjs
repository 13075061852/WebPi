import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { VIDEO_PROVIDERS, createVideoProviders, validateVideoOptions, videoSpec, videoModelDefaults } from './video-providers.mjs';
import { writeVideoJSON, validateVideoNetwork } from './video-settings.mjs';
import { VideoHTTP } from './video-http.mjs';

const DOWNLOAD_LIMIT = 512 * 1024 * 1024;
const sameCwd = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
export class VideoGeneration {
  constructor(settings, jobsFile, { providers, pricing, confirmGeneration, fetchImpl = fetch, pollMs = 10000, waitMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { settings, jobsFile, providers, pricing, confirmGeneration, fetch: fetchImpl, pollMs, waitMs, now });
    this.busy = false;
  }
  jobs() {
    if (!fsSync.existsSync(this.jobsFile)) return [];
    try { const jobs = JSON.parse(fsSync.readFileSync(this.jobsFile, 'utf8')); if (!Array.isArray(jobs)) throw Error(); return jobs; }
    catch { throw Error('视频任务记录无法读取，未提交新任务'); }
  }
  saveJob(job) {
    const jobs = this.jobs(), index = jobs.findIndex(item => item.provider === job.provider && item.id === job.id && sameCwd(item.cwd, job.cwd));
    if (index < 0) jobs.push(job); else jobs[index] = job;
    writeVideoJSON(this.jobsFile, jobs);
  }
  consumptionHistory() {
    return this.jobs().filter(job => job && job.id).map(job => ({
      id: job.id, provider: job.provider,
      providerName: VIDEO_PROVIDERS[job.provider]?.name || job.provider,
      model: job.model, createdAt: job.createdAt, status: job.status,
      duration: job.duration, resolution: job.resolution,
      actual: job.billing?.actual || job.usage || null,
      estimate: job.billing?.estimate || null,
    })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  provider(id, network = this.settings.publicConfig(id).network) {
    videoSpec(id); validateVideoNetwork(network);
    return (this.providers || createVideoProviders({ fetchImpl: this.fetch, network }))[id];
  }
  async test(input = {}) {
    const config = this.settings.publicConfig(input.provider || this.settings.read().provider);
    return this.provider(config.provider, input.network ?? config.network).test(this.settings.credential(config.provider));
  }
  async balance(input = {}) {
    const state = this.settings.publicState();
    const config = state.configs[input.provider || state.provider];
    if (!config) throw Error('无效的视频平台');
    const info = { provider: config.provider, provider_name: videoSpec(config.provider).name, model: config.model, enabled: state.enabled };
    if (!config.hasApiKey) return { ...info, available: false, message: '未配置' };
    const provider = this.provider(config.provider, config.network);
    if (!provider.balance) return { ...info, available: false, message: '暂不支持查询' };
    return { ...info, ...await provider.balance(this.settings.credential(config.provider)), updatedAt: Date.now() };
  }
  async download(url, cwd, signal, { network = 'system', downloadHeaders = {}, downloadAuthOrigins = [] } = {}) {
    let remote;
    try { remote = new URL(url); } catch { throw Error('视频下载地址无效'); }
    const http = new VideoHTTP({ fetchImpl: this.fetch, network });
    const timeout = AbortSignal.any([AbortSignal.timeout(5 * 60 * 1000), ...(signal ? [signal] : [])]);
    let response;
    for (let hop = 0; hop <= 5; hop++) {
      if (remote.protocol !== 'https:' || remote.username || remote.password) throw Error('视频下载地址无效');
      // Only explicitly allowed API origins receive download credentials, including after redirects.
      const headers = downloadAuthOrigins.includes(remote.origin) ? downloadHeaders : {};
      response = await http.raw(remote.href, { headers, signal: timeout, redirect: 'manual', timeoutMs: 5 * 60 * 1000 });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === 5) throw Error('视频下载重定向无效或次数过多');
      try { remote = new URL(location, remote); } catch { throw Error('视频下载地址无效'); }
    }
    if (!response.ok || Number(response.headers.get('content-length')) > DOWNLOAD_LIMIT) { await response.body?.cancel(); throw Error('视频下载失败或超过 512 MB'); }
    const directory = path.join(cwd, 'output');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `video-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`), partial = `${file}.part`;
    const handle = await fs.open(partial, 'wx');
    let bytes = 0, header = Buffer.alloc(0), complete = false;
    try {
      for await (const chunk of response.body || []) {
        signal?.throwIfAborted();
        bytes += chunk.length;
        if (bytes > DOWNLOAD_LIMIT) throw Error('视频超过 512 MB');
        if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
        await handle.writeFile(chunk);
      }
      if (header.toString('ascii', 4, 8) !== 'ftyp' || bytes < 24) throw Error('返回文件不是有效的 MP4 视频');
      signal?.throwIfAborted();
      complete = true;
    } finally { await handle.close(); if (!complete) await fs.unlink(partial).catch(() => {}); }
    await fs.rename(partial, file);
    return { file, bytes };
  }
  async run(callId, args, cwd, signal, onUpdate) {
    signal?.throwIfAborted();
    const publicJob = job => ({ task_id: job.id, provider: job.provider, model: job.model, provider_name: videoSpec(job.provider).name, status: job.status, usage: job.usage || null,
      timing: job.timing || null, billing: job.billing || null, ...(job.file ? { file: job.file } : {}) });
    if (args.action === 'list') return { tasks: this.jobs().filter(job => sameCwd(job.cwd, cwd)).slice(-20).map(publicJob) };
    if (args.action === 'models') {
      const state = this.settings.publicState();
      return { enabled: state.enabled, default_provider: state.provider, default_model: state.model, default_config: state.configs[state.provider], providers: state.providers.filter(spec => state.configs[spec.id].hasApiKey)
        .map(spec => ({ id: spec.id, name: spec.name, models: spec.models, modelOptions: spec.modelOptions, selected: state.configs[spec.id] })) };
    }
    if (!['generate', 'status'].includes(args.action)) throw Error('无效的视频操作');
    if (this.busy) throw Error('已有视频任务正在处理，请等待完成后查询已有任务，不要重复提交');
    this.busy = true;
    let job, selection, quote, recorded = false;
    const recordBilling = () => {
      job.billing ||= { estimate: null, actual: null };
      if (quote?.available) job.billing.estimate = quote;
      if (job.usage) job.billing.actual = job.usage;
      const estimate = job.billing.estimate;
      if (estimate?.available && job.usage?.unit === estimate.currency) {
        job.billing.delta = Number((job.usage.amount - estimate.total).toFixed(8));
        job.billing.deltaPercent = estimate.total > 0 ? Number((job.billing.delta / estimate.total * 100).toFixed(4)) : null;
      }
    };
    const update = message => onUpdate?.({ content: [{ type: 'text', text: message }], details: job ? publicJob(job) : (selection || {}) });
    try {
      const state = this.settings.publicState();
      if (!state.enabled) throw Error('请先在设置 → 视频模型中启用视频生成');
      const providerId = args.provider || state.provider;
      videoSpec(providerId);
      const config = state.configs[providerId];
      const matches = this.jobs().filter(item => sameCwd(item.cwd, cwd) && (args.action === 'status'
        ? item.id === args.task_id && (!args.provider || item.provider === args.provider) : item.callId === callId));
      if (matches.length > 1) throw Error('任务 ID 对应多个平台，请同时指定 provider');
      job = matches[0];
      recorded = Boolean(job);
      if (args.action === 'status' && !job) throw Error('当前项目中没有此视频任务，可先使用 list 查询');
      if (!job) {
        const startedAt = this.now();
        if (typeof args.prompt !== 'string' || !args.prompt.trim() || [...args.prompt].length > 7000) throw Error('视频提示词需为 1–7000 字符');
        const spec = videoSpec(config.provider);
        const model = args.model || config.model;
        const base = model !== config.model ? videoModelDefaults(config.provider, model) : config;
        const options = validateVideoOptions(config.provider, { ...base, ...Object.fromEntries(['model', 'duration', 'resolution', 'ratio'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) });
        const rules = spec.modelOptions[options.model];
        if (rules.requiresFirstFrame && !args.first_frame) throw Error('当前模型需要首帧图片');
        if (args.first_frame && !rules.supportsFirstFrame) throw Error('当前模型不支持首帧图片，请选择图生视频模型');
        selection = { provider: config.provider, provider_name: spec.name, model: options.model, status: 'preparing' };
        let firstFrame;
        if (args.first_frame) {
          if (typeof args.first_frame !== 'string') throw Error('首帧图片路径无效');
          const file = path.resolve(cwd, args.first_frame), stat = await fs.stat(file);
          const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()];
          if (!mime || !stat.isFile() || stat.size > 30 * 1024 * 1024) throw Error('首帧图片须为 PNG/JPEG/WebP，最大 30 MB');
          firstFrame = `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`;
        }
        const key = this.settings.credential(config.provider);
        if (!this.confirmGeneration) throw Error('视频生成需要用户确认，当前没有确认入口。请使用 Three.js、Canvas 或 CSS 等方式实现动画，不要绕过确认调用视频 API。');
        if (this.pricing) quote = await Promise.race([
          this.pricing.estimate({ provider: config.provider, network: config.network, ...options, inputImageCount: firstFrame ? 1 : 0 }).catch(() => null),
          delay(3000).then(() => null),
        ]);
        signal?.throwIfAborted();
        update(`${spec.name} · ${options.model}：等待用户确认视频生成`);
        const approved = await this.confirmGeneration({ provider: config.provider, providerName: spec.name,
          ...options, prompt: args.prompt.trim(), firstFrame: args.first_frame || null, cwd, estimate: quote }, signal);
        signal?.throwIfAborted();
        if (approved !== true) return { status: 'cancelled', message: '用户未确认视频生成，未提交平台、未产生生成费用。请改用 Three.js、Canvas 或 CSS 动画，不要重复请求或绕过确认调用视频 API。' };
        update(`${spec.name} · ${options.model}：正在提交视频任务…`);
        let id;
        try { id = await this.provider(config.provider, config.network).create(key, { ...options, prompt: args.prompt.trim(), firstFrame }, signal); }
        catch (error) { throw Error(`${error.message}。提交结果不确定时请到 ${spec.name} 平台核对，勿自动重复生成。`); }
        const submittedAt = this.now();
        job = { id, provider: config.provider, ...options, network: config.network, cwd: path.resolve(cwd), callId, status: 'queued', createdAt: new Date(submittedAt).toISOString(),
          startedAt, submittedAt, timing: { submissionMs: Math.max(0, submittedAt - startedAt) },
          billing: { requested: { ...options, inputType: firstFrame ? 'image' : 'text' }, estimate: null, actual: null } };
        try { this.saveJob(job); recorded = true; } catch { throw Error(`视频任务已提交（${id}），但本地记录保存失败；请到 ${spec.name} 平台查询，勿重新提交`); }
      }
      const delivered = job.file && fsSync.existsSync(job.file);
      // An explicit status query can refresh settlement without re-generating/re-downloading.
      if (delivered && args.action !== 'status') return publicJob(job);
      const network = job.network ?? this.settings.publicConfig(job.provider).network;
      const provider = this.provider(job.provider, network), key = this.settings.credential(job.provider);
      const deadline = Date.now() + this.waitMs;
      do {
        signal?.throwIfAborted();
        const result = await provider.query(key, job.id, signal);
        if (delivered && result.status !== 'succeeded') return { ...publicJob(job), message: '本地视频已交付，平台结算状态尚未更新' };
        job.status = result.status;
        if (result.usage) job.usage = result.usage;
        recordBilling();
        if (result.billing) job.billing.platform = result.billing;
        job.billing.checkedAt = new Date(this.now()).toISOString();
        job.timing ||= {};
        if (Number.isFinite(result.generationMs) && result.generationMs >= 0) job.timing.platformMs = result.generationMs;
        if (['succeeded', 'failed', 'cancelled'].includes(job.status) && !job.generationCompletedAt) {
          job.generationCompletedAt = this.now();
          if (Number.isFinite(job.submittedAt)) job.timing.generationMs = Math.max(0, job.generationCompletedAt - job.submittedAt);
        }
        this.saveJob(job);
        if (delivered) return publicJob(job);
        update(`${videoSpec(job.provider).name} · ${job.model}：${{ queued: '排队中', running: '生成中', succeeded: '正在下载', failed: '失败', cancelled: '已取消' }[job.status]}`);
        if (job.status === 'succeeded') {
          const downloadStartedAt = this.now();
          const output = await this.download(result.url, cwd, signal, { ...result, network });
          const completedAt = this.now();
          job.timing.downloadMs = Math.max(0, completedAt - downloadStartedAt);
          if (Number.isFinite(job.startedAt)) job.timing.totalMs = Math.max(0, completedAt - job.startedAt);
          job.completedAt = completedAt;
          recordBilling();
          Object.assign(job, output); this.saveJob(job);
          return { ...publicJob(job), bytes: output.bytes, message: '视频已下载并完成 MP4 基本校验，界面已可播放。请立即返回视频链接、实际模型与消耗；用户未要求时无需额外截图、解码检查或外发。' };
        }
        if (['failed', 'cancelled'].includes(job.status)) return { ...publicJob(job), error: result.error || '视频任务未完成' };
        if (Date.now() >= deadline) break;
        const interval = job.provider === 'apimart' ? Math.min(this.pollMs, 5000) : this.pollMs;
        await delay(Math.min(interval, Math.max(1, deadline - Date.now())), undefined, { signal });
      } while (Date.now() < deadline);
      return { ...publicJob(job), message: '任务仍在云端生成，使用 status 和此 task_id 继续查询，不要重新生成' };
    } catch (error) {
      if (!job) throw error;
      return { ...publicJob(job), error: signal?.aborted ? '已停止本地等待；云端任务可能继续，稍后用 status 查询' : error.message,
        message: recorded ? '已保留 task_id，使用 status 重试查询或下载，不要重新提交生成任务' : '请记录 task_id 并到平台查询，勿重新提交生成任务' };
    } finally { this.busy = false; }
  }
}

export function videoTool(cwd, getService) {
  return {
    name: 'video_generate', label: '视频生成',
    description: '“动起来”“做动画”等请求优先使用 Three.js、Canvas、CSS 等本地动画方式，不要自行理解为调用视频模型。调用收费视频生成 API 前必须由用户在确认窗口中明确同意，即使用户说生成视频也不能跳过确认。未确认或拒绝时改用其他实现方式，禁止通过脚本或其他工具绕过确认直接调用视频 API。先用 models 查看同一套 default_config 和参数要求。用户未指定厂家、模型、分辨率、时长或比例时，generate 省略对应参数，使用保存的默认配置，不从历史模型沿用参数。用户明确指定时才覆盖相应参数。参数校验失败时按错误说明修正，不更换模型。generate 提交并等待视频，可指定本地首帧 first_frame；status 用原 provider/task_id 继续查询或下载；list 查当前项目最近任务。成功取得 file 后立即返回 Markdown 视频链接，说明实际 provider_name、model 和 usage.amount/usage.unit；usage 为 null 时说明平台未返回实际消耗，不以预估代替。文件已下载并完成 MP4 基本校验，界面可播放；用户未要求画面验收时，不再搜索 ffmpeg、运行抽帧/解码脚本或调用 preview_inspect，不以额外检查拖延交付；用户未明确要求时不发送到微信等外部渠道。失败/超时不要重新 generate，先 status，避免重复计费。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['generate', 'status', 'list', 'models'] }, prompt: { type: 'string' }, task_id: { type: 'string' },
      provider: { type: 'string', enum: Object.keys(VIDEO_PROVIDERS) }, model: { type: 'string' },
      first_frame: { type: 'string', description: '可选，用户指定的首帧图片本地路径' },
      duration: { type: 'integer', minimum: 1, maximum: 30 }, resolution: { type: 'string' }, ratio: { type: 'string' },
    }, required: ['action'] },
    execute: async (id, args, signal, onUpdate) => {
      const service = getService();
      if (!service) throw Error('视频服务尚未就绪');
      const result = await service.run(id, args, cwd, signal, onUpdate);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}
