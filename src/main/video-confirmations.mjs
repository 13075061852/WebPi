import { randomUUID } from 'node:crypto';
import { validateVideoOptions, videoSpec } from './video-providers.mjs';

export class VideoConfirmations {
  pending = new Map();
  list() { return [...this.pending].map(([id, entry]) => ({ ...entry.request, id })); }
  ask(request, signal, publish) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = value => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', cancel);
        resolve(value);
      };
      const cancel = () => finish(false);
      this.pending.set(id, { request, finish });
      signal?.addEventListener('abort', cancel, { once: true });
      try { publish({ ...request, id }); }
      catch (error) { this.pending.delete(id); signal?.removeEventListener('abort', cancel); reject(error); }
    });
  }
  respond({ id, approved, options } = {}) {
    const entry = this.pending.get(id);
    if (!entry) throw Error('此确认已结束，请查看当前任务状态');
    if (approved !== true) { entry.finish(false); return true; }
    const validated = validateVideoOptions(entry.request.provider, options);
    const rules = videoSpec(entry.request.provider).modelOptions[validated.model];
    if (rules.requiresFirstFrame && !entry.request.firstFrame) throw Error('该模型需要首帧图片，请选择文生视频模型');
    if (entry.request.firstFrame && !rules.supportsFirstFrame) throw Error('该模型不支持首帧图片');
    entry.finish({ approved: true, options: validated });
    return true;
  }
  dispose() { for (const entry of this.pending.values()) entry.finish(false); }
}
