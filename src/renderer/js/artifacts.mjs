export function artifactPath(value, cwd) {
  if (typeof value !== 'string') return null;
  let p = value.trim().replace(/^<|>$/g, '').replace(/\\/g, '/');
  if (p.startsWith('halo-preview://local/')) { try { p=decodeURIComponent(p.slice(21)); } catch {return null;} }
  else if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[a-z]:\//i.test(p)) return null;
  if (!/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|svg|csv|html?|md|txt|zip|mp4|webm|mp3|wav|m4a|aac|ogg|flac)$/i.test(p)) return null;
  if (!/^(?:[a-z]:\/|\/)/i.test(p)) p = cwd.replace(/\\/g,'/').replace(/\/$/,'')+'/'+p;
  const parts=[];
  for(const part of p.split('/')) {if(part==='..')parts.pop();else if(part!=='.')parts.push(part);}
  return parts.join('/');
}
export function replyArtifacts(text, cwd) {
  const files = new Map();
  for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\n]+?))\s*\)/g)) {
    const p=artifactPath(match[1]||match[2],cwd);
    if(p)files.set(p.toLowerCase(),p);
  }
  // Final replies may deliver a path in inline code instead of a Markdown link.
  for (const match of text.matchAll(/`([^`\r\n]+)`/g)) {
    const value=match[1];
    if (!/[\\/]/.test(value)) continue;
    const p=artifactPath(value,cwd);
    if(p)files.set(p.toLowerCase(),p);
  }
  // Models also deliver unlinked absolute paths, often wrapped in bold text.
  // Validate candidates through artifactFiles before displaying any cards.
  const barePath = /(?:^|[\s*`("'：])((?:[a-z]:[\\/]|\/(?!\/))[^\r\n<>|"*`?]+?\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|svg|csv|html?|md|txt|zip|mp4|webm|mp3|wav|m4a|aac|ogg|flac))(?=$|[\s*`"')（），。；,;])/gim;
  for (const match of text.matchAll(barePath)) {
    const p = artifactPath(match[1], cwd);
    if (p) files.set(p.toLowerCase(), p);
  }
  return [...files.values()];
}

const playableFile = /\.(mp4|webm|mp3|wav|m4a|aac|ogg|flac)$/i;
const playbackWords = /^(?:(?:点击|直接|立即|在线|播放|观看|查看|预览|打开|试听|视频|音频|成片|短片|录音|片段|play|watch|preview|listen|open|video|audio|clip|film|the))+$/i;
function playbackLabel(text, file) {
  const name = file.split('/').pop().toLowerCase();
  let label = text.trim().toLowerCase();
  const named = label.includes(name);
  if (named) label = label.replace(name, '');
  label = label.replace(/[\s\p{P}▶▷►⏵🎬🎥🔊🔈🔉⏯️]/gu, '');
  return !label ? named : playbackWords.test(label);
}

// Only hide redundant playback rows once their local file has a usable card.
// Keep the original nodes so a later file check can restore unavailable links.
// This also works with frozen streaming paragraphs without changing raw text.
export function filterArtifactPlayback(root, cwd, files = []) {
  for (const node of root.querySelectorAll('[data-artifact-playback]')) {
    if (node.dataset.artifactPlayback === 'line') node.replaceWith(...node.childNodes);
    else { node.hidden = false; delete node.dataset.artifactPlayback; }
  }
  const delivered = new Set(files.filter(file => playableFile.test(file)).map(file => file.toLowerCase()));
  if (!delivered.size) return;
  for (const block of root.querySelectorAll('p, li')) {
    if (block.closest('blockquote, table, pre') || block.querySelector('ul, ol, input, img, video, audio')) continue;
    const lines = [{ nodes: [] }], breaks = [];
    for (const node of block.childNodes) {
      if (node.nodeName === 'BR') { breaks.push(node); lines.push({ nodes: [] }); }
      else lines.at(-1).nodes.push(node);
    }
    for (const line of lines) {
      const links = line.nodes.flatMap(node => node.nodeType === 1
        ? [...(node.matches('a[href]') ? [node] : []), ...node.querySelectorAll('a[href]')] : []);
      if (links.length !== 1 || links[0].closest('code')) continue;
      const file = artifactPath(links[0].getAttribute('href'), cwd);
      if (!file || !delivered.has(file.toLowerCase())) continue;
      const elements = line.nodes.flatMap(node => node.nodeType === 1 ? [node, ...node.querySelectorAll('*')] : []);
      if (elements.some(node => !/^(A|B|STRONG|I|EM|SPAN|CODE|DEL)$/.test(node.nodeName))) continue;
      if (!playbackLabel(line.nodes.map(node => node.textContent).join(''), file)) continue;
      const hidden = root.ownerDocument.createElement('span');
      hidden.dataset.artifactPlayback = 'line'; hidden.hidden = true;
      line.nodes[0].before(hidden); hidden.append(...line.nodes);
      line.hidden = true;
    }
    if (!lines.some(line => line.hidden)) continue;
    const visible = lines.map((line, index) => !line.hidden && line.nodes.some(node => node.textContent.trim()) ? index : -1).filter(index => index >= 0);
    const keepBreaks = new Set(visible.slice(1).map(index => index - 1));
    breaks.forEach((node, index) => {
      if (!keepBreaks.has(index)) { node.dataset.artifactPlayback = 'space'; node.hidden = true; }
    });
    if (!visible.length) { block.dataset.artifactPlayback = 'empty'; block.hidden = true; }
  }
  for (const list of root.querySelectorAll('ul, ol')) {
    if (list.children.length && [...list.children].every(node => node.hidden)) {
      list.dataset.artifactPlayback = 'empty'; list.hidden = true;
    }
  }
}

const fileDesigns = {
  audio: ['audio','音频','<path d="M9 18V5l12-2v13M9 9l12-2"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'],
  video: ['video','视频','<rect x="3" y="5" width="12" height="14" rx="2"/><path d="m15 10 6-4v12l-6-4"/>'],
  pptx: ['slides','演示文稿','<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21l4-4 4 4M8 8h8M8 12h4"/>'],
  pdf: ['pdf','PDF 文档','<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'],
  docx: ['word','Word 文档','<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 12h8M8 15h8M8 18h5"/>'],
  xlsx: ['sheet','Excel 表格','<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11M15 9v11"/>'],
  image: ['image','图片','<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>'],
  html: ['code','网页','<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>'],
  zip: ['archive','压缩文件','<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 3v3h2v3h-2v3h2v3M10 15h4v3h-4z"/>'],
  text: ['text','文本文件','<path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/>']
};
export function decorateArtifactCard(button, file, imageURL, { bytes } = {}) {
  const name = file.split(/[\\/]/).pop();
  const ext = name.split('.').pop().toLowerCase();
  const key = ({ppt:'pptx',doc:'docx',xls:'xlsx',csv:'xlsx',htm:'html',mp4:'video',webm:'video',mp3:'audio',wav:'audio',m4a:'audio',aac:'audio',ogg:'audio',flac:'audio'})[ext] || (/^(png|jpe?g|gif|webp|svg)$/.test(ext) ? 'image' : ext);
  const [kind,description,paths] = fileDesigns[key] || fileDesigns.text;
  button.className = 'artifact-card artifact-' + kind;
  button.title = file;
  button.setAttribute('aria-label', '预览' + description + '：' + name);
  const art = document.createElement('span');art.className='artifact-art';
  art.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+paths+'</svg>';
  const mediaInfo = document.createElement('span'); mediaInfo.className = 'artifact-media-info';
  const size = Number.isFinite(bytes) && bytes >= 0 ? (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`) : '大小未知';
  const showDuration = duration => {
    const seconds = Math.round(duration);
    const time = Number.isFinite(duration) && duration >= 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '时长未知';
    mediaInfo.textContent = `${size} · ${time}`;
  };
  showDuration(NaN);
  if(kind==='image') {
    const thumbnail=document.createElement('img');thumbnail.src=imageURL;thumbnail.alt='';thumbnail.loading='lazy';thumbnail.decoding='async';
    thumbnail.onerror=()=>thumbnail.remove();art.appendChild(thumbnail);
  } else if (kind === 'video') {
    const thumbnail = document.createElement('video');
    thumbnail.className = 'artifact-video-thumbnail';
    thumbnail.muted = true; thumbnail.playsInline = true; thumbnail.preload = 'metadata';
    thumbnail.tabIndex = -1; thumbnail.setAttribute('aria-hidden', 'true');
    // Decode a single frame locally; playback belongs to the center preview.
    thumbnail.onloadedmetadata = () => {
      showDuration(thumbnail.duration);
      if (Number.isFinite(thumbnail.duration) && thumbnail.duration > 0) {
        try { thumbnail.currentTime = Math.min(0.1, thumbnail.duration / 2); } catch {}
      }
    };
    thumbnail.onerror = () => thumbnail.remove();
    thumbnail.src = imageURL;
    const play = document.createElement('span'); play.className = 'artifact-video-play';
    play.setAttribute('aria-hidden', 'true');
    play.innerHTML = '<svg viewBox="0 0 16 16"><path d="m6 3 7 5-7 5z"/></svg>';
    art.append(thumbnail, play);
  } else if (kind === 'audio') {
    const audio = document.createElement('audio'); audio.preload = 'metadata'; audio.hidden = true;
    audio.onloadedmetadata = () => showDuration(audio.duration);
    audio.onerror = () => showDuration(NaN);
    audio.src = imageURL; art.append(audio);
  }
  const copy=document.createElement('span');copy.className='artifact-copy';
  const label=document.createElement('span');label.className='artifact-name';label.textContent=name;
  const meta=document.createElement('span');meta.className='artifact-meta';
  const badge=document.createElement('span');badge.className='artifact-kind';badge.textContent=ext.toUpperCase();
  const hint=document.createElement('span');hint.textContent=description;
  meta.append(badge,hint);copy.append(label,meta);
  if (kind === 'video' || kind === 'audio') copy.append(mediaInfo);
  const arrow=document.createElement('span');arrow.className='artifact-open';arrow.setAttribute('aria-hidden','true');arrow.innerHTML='<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>';
  button.append(art,copy,arrow);
}
