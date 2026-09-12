export function artifactPath(value, cwd) {
  if (typeof value !== 'string') return null;
  let p = value.trim().replace(/^<|>$/g, '').replace(/\\/g, '/');
  if (p.startsWith('halo-preview://local/')) { try { p=decodeURIComponent(p.slice(21)); } catch {return null;} }
  else if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[a-z]:\//i.test(p)) return null;
  if (!/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|svg|csv|html?|md|txt|zip)$/i.test(p)) return null;
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
  return [...files.values()];
}

const fileDesigns = {
  pptx: ['slides','演示文稿','<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21l4-4 4 4M8 8h8M8 12h4"/>'],
  pdf: ['pdf','PDF 文档','<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'],
  docx: ['word','Word 文档','<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 12h8M8 15h8M8 18h5"/>'],
  xlsx: ['sheet','Excel 表格','<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11M15 9v11"/>'],
  image: ['image','图片','<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>'],
  html: ['code','网页','<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>'],
  zip: ['archive','压缩文件','<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 3v3h2v3h-2v3h2v3M10 15h4v3h-4z"/>'],
  text: ['text','文本文件','<path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/>']
};
export function decorateArtifactCard(button, file, imageURL) {
  const name = file.split(/[\\/]/).pop();
  const ext = name.split('.').pop().toLowerCase();
  const key = ({ppt:'pptx',doc:'docx',xls:'xlsx',csv:'xlsx',htm:'html'})[ext] || (/^(png|jpe?g|gif|webp|svg)$/.test(ext) ? 'image' : ext);
  const [kind,description,paths] = fileDesigns[key] || fileDesigns.text;
  button.className = 'artifact-card artifact-' + kind;
  button.title = file;
  button.setAttribute('aria-label', '预览' + description + '：' + name);
  const art = document.createElement('span');art.className='artifact-art';
  art.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+paths+'</svg>';
  if(kind==='image') {
    const thumbnail=document.createElement('img');thumbnail.src=imageURL;thumbnail.alt='';thumbnail.loading='lazy';thumbnail.decoding='async';
    thumbnail.onerror=()=>thumbnail.remove();art.appendChild(thumbnail);
  }
  const copy=document.createElement('span');copy.className='artifact-copy';
  const label=document.createElement('span');label.className='artifact-name';label.textContent=name;
  const meta=document.createElement('span');meta.className='artifact-meta';
  const badge=document.createElement('span');badge.className='artifact-kind';badge.textContent=ext.toUpperCase();
  const hint=document.createElement('span');hint.textContent=description;
  meta.append(badge,hint);copy.append(label,meta);
  const arrow=document.createElement('span');arrow.className='artifact-open';arrow.setAttribute('aria-hidden','true');arrow.innerHTML='<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>';
  button.append(art,copy,arrow);
}
