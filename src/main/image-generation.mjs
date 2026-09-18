import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function resolveImageCredential(runtime) {
  // Public Pi auth resolver refreshes and persists subscription tokens as needed.
  const result = await runtime.getAuth('openai-codex');
  const access = result?.auth?.apiKey;
  if (!access) throw Error('请先在模型登录中登录 OpenAI Codex 订阅账户');
  let claims;
  try { claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8')); } catch { throw Error('OpenAI Codex 订阅凭据无效，请重新登录'); }
  const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accountId) throw Error('登录凭据缺少订阅账户信息，请重新登录 OpenAI Codex');
  return {access, accountId};
}

let busy = false;
const LIMIT = 32 * 1024 * 1024;

export async function readGeneratedImage(response, signal) {
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`订阅生图请求失败（HTTP ${response.status}）${response.status === 401 ? '，请重新登录 OpenAI Codex' : response.status === 429 ? '，额度或请求频率受限，请稍后再试' : ''}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', bytes = 0, image = null, completed = false;
  const parse = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw Error('生图服务未完成请求，请检查账户权限或稍后重试');
    if (event.type === 'response.output_item.done' && event.item?.type === 'image_generation_call' && event.item.result) image = event.item.result;
    if (event.type === 'response.completed') {
      completed = true;
      image ||= event.response?.output?.find(item => item.type === 'image_generation_call')?.result;
    }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMIT) throw Error('生图响应超过 32 MB 限制');
      pending += decoder.decode(value, {stream:true});
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) parse(pending);
    if (!completed || !image) throw Error('服务未返回完整图片；未保存文件，也不会自动重复扣用额度');
    const buffer = Buffer.from(image, 'base64');
    const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const webp = buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP';
    if (!png && !jpeg && !webp) throw Error('生图返回的数据不是受支持的图片');
    return {buffer, extension:png?'png':jpeg?'jpg':'webp'};
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

export function imageTool(cwd, getCredential) {
  return {
    name:'image_generate', label:'图片生成',
    description:'使用 Pi 已登录的 OpenAI Codex 订阅生成图片或按本地参考图编辑，消耗订阅额度，无需 API Key。先读取 halo-imagegen 技能。只返回最终文件路径，不返回 base64。',
    parameters:{type:'object',properties:{prompt:{type:'string',description:'要生成的图片、用途、构图和需要保留的内容'},references:{type:'array',items:{type:'string'},maxItems:3,description:'可选，用户指定的本地参考图片路径，最多3张'}},required:['prompt']},
    execute:async(_id,args,signal)=>{
      const startedAt = Date.now();
      signal?.throwIfAborted();
      if (busy) throw Error('已有生图任务进行中，请等待完成');
      if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 12000) throw Error('生图提示词需为 1–12000 字符');
      if (args.references && (!Array.isArray(args.references) || args.references.length > 3)) throw Error('参考图最多3张');
      busy = true;
      try {
        const credential = await getCredential();
        if (!credential?.access || !credential?.accountId) throw Error('请先在模型登录中登录 OpenAI Codex 订阅账户');
        const content = [{type:'input_text',text:args.prompt}];
        for (const file of args.references || []) {
          if (typeof file !== 'string') throw Error('参考图路径无效');
          const full = path.resolve(cwd,file), stat = await fs.stat(full);
          const mime = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(full).toLowerCase()];
          if (!mime || !stat.isFile() || stat.size > 8*1024*1024) throw Error('参考图须为 PNG/JPEG/WebP，单张不超过8 MB');
          content.push({type:'input_image',image_url:`data:${mime};base64,${(await fs.readFile(full)).toString('base64')}`});
        }
        const requestSignal = AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
        const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
          method:'POST', signal:requestSignal,
          headers:{Authorization:`Bearer ${credential.access}`,'chatgpt-account-id':credential.accountId,originator:'pi','OpenAI-Beta':'responses=experimental','content-type':'application/json',accept:'text/event-stream'},
          body:JSON.stringify({model:'gpt-6-astra',store:false,stream:true,instructions:'Generate exactly one image using image_generation. Follow the user prompt. Preserve requested details in reference images.',input:[{role:'user',content}],tools:[{type:'image_generation'}],tool_choice:{type:'image_generation'}})
        });
        const {buffer,extension} = await readGeneratedImage(response,requestSignal);
        requestSignal.throwIfAborted();
        const dir = path.join(cwd,'output');
        await fs.mkdir(dir,{recursive:true});
        const file = path.join(dir,`image-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${extension}`);
        await fs.writeFile(file,buffer,{flag:'wx'});
        const finishedAt = Date.now();
        const result = {file,bytes:buffer.length,provider:'openai-codex',visualChecked:false,
          sha256:crypto.createHash('sha256').update(buffer).digest('hex'),
          timing:{startedAt,finishedAt,totalMs:finishedAt-startedAt}};
        return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
      } finally { busy = false; }
    }
  };
}
