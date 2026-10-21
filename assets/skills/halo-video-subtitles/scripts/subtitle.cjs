'use strict';
// Only Node built-ins. ASR is a small whisper.cpp CPU binary, never a Python package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const runtime = path.join(os.homedir(), '.pi/tools/video-subtitles-lite');

function existing(file) {
  const p = path.resolve(file || '');
  if (!fs.statSync(p, { throwIfNoEntry: false })?.isFile()) throw Error(`File missing: ${p}`);
  return p;
}
function fresh(file) {
  const p = path.resolve(file);
  if (fs.existsSync(p)) throw Error(`Refusing to overwrite: ${p}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
function config(args = {}) {
  const file = path.join(runtime, 'config.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  return { ...saved, ffmpeg: args.ffmpeg || process.env.HALO_SUBTITLE_FFMPEG || saved.ffmpeg || 'ffmpeg' };
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { log, ...spawnOptions } = options;
    const output = log ? fs.createWriteStream(log, { flags: 'wx' }) : null;
    let stdout = '', stderr = '', done = false;
    const child = spawn(command, args.map(String), { ...spawnOptions, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* unsupported host or process already ended */ }
    const finish = (error, result) => {
      if (done) return;
      done = true;
      if (output) output.end();
      if (error) reject(error); else resolve(result);
    };
    output?.on('error', error => { child.kill(); finish(error); });
    child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString('utf8')).slice(-2000000); output?.write(bytes); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-2000000); output?.write(bytes); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, { code, stdout, stderr }));
  });
}
async function inspect(file, ffmpeg) {
  const r = await run(ffmpeg, ['-hide_banner', '-threads', '1', '-i', existing(file)]);
  const duration = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const video = r.stderr.split(/\r?\n/).find(line => /Stream .*Video:/.test(line));
  const size = video?.match(/\b(\d{2,6})x(\d{2,6})\b/);
  if (!duration || !video || !size) throw Error(`Cannot inspect video: ${r.stderr.slice(-1000)}`);
  return { duration: +duration[1]*3600 + +duration[2]*60 + +duration[3], width: +size[1], height: +size[2],
    audio: /Stream .*Audio:/.test(r.stderr), subtitleTracks: (r.stderr.match(/Stream .*Subtitle:/g) || []).length,
    hdr: /smpte2084|arib-std-b67/i.test(video) };
}
function normalizeCues(project) {
  const rows = Array.isArray(project) ? project : project.cues;
  if (!Array.isArray(rows) || !rows.length) throw Error('Expected nonempty cues.');
  let end = 0;
  return rows.map((cue, i) => {
    const start = Math.round(Number(cue.start)*1000)/1000, stop = Math.round(Number(cue.end)*1000)/1000;
    const text = String(cue.target ?? cue.text ?? '').replace(/\r/g, '').trim();
    if (!Number.isFinite(start+stop) || start < end || start < 0 || stop <= start) throw Error(`Invalid/overlapping timing at cue ${i+1}.`);
    if (!text || text.split('\n').length > 2 || text.split('\n').some(line => !line.trim()) || /[{}\\]|-->/.test(text)) throw Error(`Invalid text at cue ${i+1}.`);
    end = stop;
    return { start, end: stop, text };
  });
}
function stamp(t) {
  const ms = Math.round(t*1000);
  return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;
}
function makeSrt(project) {
  return normalizeCues(project).map((c, i) => `${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}`).join('\n\n')+'\n';
}
function readSrt(file) {
  const rows = fs.readFileSync(existing(file), 'utf8').replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n\s*\n/).map(block => {
    const lines = block.split('\n');
    const m = lines[1]?.match(/^(\d+):(\d{2}):(\d{2}),(\d{3}) --> (\d+):(\d{2}):(\d{2}),(\d{3})$/);
    if (!/^\d+$/.test(lines[0]) || !m || Math.max(+m[2],+m[3],+m[6],+m[7]) > 59) throw Error('Invalid UTF-8 SRT.');
    return { start: +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000,
      end: +m[5]*3600 + +m[6]*60 + +m[7] + +m[8]/1000, text: lines.slice(2).join('\n') };
  });
  return normalizeCues(rows);
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function verify(file, reference, ffmpeg) {
  const info = await inspect(file, ffmpeg);
  if (reference) {
    const src = await inspect(reference, ffmpeg);
    if (Math.abs(info.duration-src.duration) > .25 || (src.audio && !info.audio) ||
        [info.width,info.height].sort((a,b)=>a-b).join() !== [src.width,src.height].sort((a,b)=>a-b).join()) throw Error('Output duration, dimensions or audio do not match source.');
  }
  const result = await run(ffmpeg, ['-hide_banner','-v','error','-nostdin','-xerror','-threads','1','-readrate','4','-i',file,
    '-map','0:v:0','-map','0:a?','-threads','1','-f','null','-']);
  if (result.code !== 0 || result.stderr.trim()) throw Error(`Full decode failed: ${result.stderr}`);
  return { ...info, passed: true, fullDecodeExit: 0, sha256: await digest(file), sourceSha256: reference ? await digest(reference) : null };
}
async function transcribe(args, cfg) {
  const source = existing(args.input), out = fresh(args.output);
  const whisper = existing(args.whisper || cfg.whisper), model = existing(args.model || cfg.model);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'halo-asr-lite-'));
  const wav = path.join(temp,'audio.wav'), prefix = path.join(temp,'asr');
  try {
    const clip = args.duration ? ['-t',String(args.duration)] : [];
    const decoded = await run(cfg.ffmpeg, ['-hide_banner','-v','error','-nostdin','-n','-threads','1',
      '-ss',String(args.start || 0),'-i',source,...clip,'-map','0:a:0','-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav]);
    if (decoded.code) throw Error(decoded.stderr);
    const prompt = args.prompt ? ['--prompt',args.prompt] : [];
    const r = await run(whisper, ['-m',model,'-f',wav,'-t','1','-p','1','-l',args.language || 'auto','-ng','-np','-ojf','-of',prefix,...prompt]);
    if (r.code || !fs.existsSync(prefix+'.json')) throw Error(`Local recognition failed: ${r.stderr}`);
    const raw = JSON.parse(fs.readFileSync(prefix+'.json','utf8')), offset = Number(args.start || 0);
    const cues = raw.transcription.filter(s => s.text.trim()).map((s,i) => ({ id:i+1,
      start:s.offsets.from/1000+offset, end:s.offsets.to/1000+offset, source:s.text.trim(), target:'',
      tokens:(s.tokens || []).filter(t => !/^\[_/.test(t.text)).map(t => ({text:t.text,start:t.offsets.from/1000+offset,end:t.offsets.to/1000+offset,probability:t.p})) }));
    if (!cues.length) throw Error('No speech recognized; review the audio instead of inventing captions.');
    fs.writeFileSync(out, JSON.stringify({engine:'whisper.cpp',source,source_language:raw.result?.language || args.language,
      target_language:'zh-Hans',model:path.basename(model),cues},null,2),{flag:'wx'});
    console.log(out);
  } finally {
    // Exact list of files created by this operation, not a recursive unknown path.
    for (const file of [wav,prefix+'.json']) if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.readdirSync(temp).length === 0) fs.rmdirSync(temp);
  }
}
async function render(args, cfg) {
  const source = existing(args.input), rows = readSrt(args.srt), out = fresh(args.output);
  if (path.extname(out).toLowerCase() !== '.mp4') throw Error('Expected .mp4 output.');
  const info = await inspect(source,cfg.ffmpeg);
  if (info.hdr) throw Error('HDR source requires an explicit HDR/SDR workflow.');
  if (rows.at(-1).end > info.duration+.05) throw Error('Subtitles exceed video duration.');
  const partial = out.slice(0,-4)+'.'+crypto.randomUUID()+'.partial.mp4';
  const log = fresh(out+'.render.log'), report = fresh(out+'.verification.json');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'halo-subs-lite-'));
  const captions = path.join(temp,'captions.srt');
  fs.writeFileSync(captions,makeSrt(rows));
  console.log(`RENDER_LOG=${log}`);
  try {
    const font = process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC';
    const style = `FontName=${font},FontSize=20,Outline=1.3,Shadow=0.4,Alignment=2,MarginV=18`;
    const r = await run(cfg.ffmpeg,['-hide_banner','-nostdin','-n','-threads','1','-filter_threads','1','-filter_complex_threads','1',
      '-readrate','0.75','-i',source,'-map','0:v:0','-map','0:a?','-vf',`subtitles=captions.srt:force_style='${style}'`,
      '-c:v','libx264','-threads:v','1','-x264-params','threads=1:lookahead_threads=1','-preset','veryfast','-crf','19',
      '-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-threads:a','1','-movflags','+faststart',partial],{cwd:temp,log});
    if (r.code) throw Error(`Encoding failed. Partial retained: ${partial}`);
    const result = await verify(partial,source,cfg.ffmpeg);
    if (fs.existsSync(out)) throw Error('Final file appeared during encoding; partial retained.');
    // Hard-link publication fails atomically if a final file already exists.
    fs.linkSync(partial,out); fs.unlinkSync(partial);
    fs.writeFileSync(report,JSON.stringify(result,null,2),{flag:'wx'});
    console.log(`EXPORT_OK=${out}`);
  } finally { fs.unlinkSync(captions); fs.rmdirSync(temp); }
}
function parse(argv) {
  const [command,...rest] = argv, args = {};
  for (let i=0;i<rest.length;i+=2) {
    if (!rest[i].startsWith('--') || rest[i+1] === undefined || rest[i+1].startsWith('--')) throw Error('Expected --option value pairs.');
    args[rest[i].slice(2)] = rest[i+1];
  }
  return {command,args};
}
async function main(argv) {
  const {command,args} = parse(argv), cfg = config(args);
  if (command === 'status') { console.log(JSON.stringify({runtime,ffmpeg:cfg.ffmpeg,whisper:cfg.whisper || null,model:cfg.model || null,modelBytes:cfg.model && fs.existsSync(cfg.model) ? fs.statSync(cfg.model).size : 0},null,2)); return; }
  if (['start','duration'].some(k => args[k] !== undefined && (!Number.isFinite(Number(args[k])) || Number(args[k]) < (k === 'duration' ? .001 : 0)))) throw Error('Invalid clip times.');
  if (command === 'inspect') console.log(JSON.stringify(await inspect(args.input,cfg.ffmpeg),null,2));
  else if (command === 'transcribe') await transcribe(args,cfg);
  else if (command === 'make-srt') fs.writeFileSync(fresh(args.output),makeSrt(JSON.parse(fs.readFileSync(existing(args.project),'utf8').replace(/^\uFEFF/,''))),{flag:'wx'});
  else if (command === 'render') await render(args,cfg);
  else if (command === 'frames') {
    const file = existing(args.input), dir = path.resolve(args.dir), reference = existing(args.reference);
    fs.mkdirSync(dir,{recursive:true});
    const cached = file+'.verification.json';
    let report = fs.existsSync(cached) ? JSON.parse(fs.readFileSync(cached,'utf8')) : null;
    if (!(report?.passed && report.fullDecodeExit === 0 && report.sha256 === await digest(file) && report.sourceSha256 === await digest(reference))) report = await verify(file,reference,cfg.ffmpeg);
    const times = (args.at || [.1,.5,.9].map(x=>x*report.duration).join(',')).split(',').map(Number);
    for (let i=0;i<times.length;i++) {
      if (!Number.isFinite(times[i]) || times[i] < 0 || times[i] >= report.duration) throw Error('Frame timestamp out of range.');
      const target = fresh(path.join(dir,`frame-${i+1}.jpg`));
      const r = await run(cfg.ffmpeg,['-v','error','-nostdin','-n','-threads','1','-ss',String(times[i]),'-i',file,'-filter_threads','1','-frames:v','1','-vf','scale=960:-2',target]);
      if (r.code || !fs.existsSync(target)) throw Error('Frame extraction failed.');
    }
    console.log(JSON.stringify({passed:true,frames:times.length,dir},null,2));
  } else throw Error('Commands: status, inspect, transcribe, make-srt, render, frames. No package or model downloads happen here.');
}
module.exports = {normalizeCues,makeSrt,readSrt,inspect,verify,main};
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode=1; });
