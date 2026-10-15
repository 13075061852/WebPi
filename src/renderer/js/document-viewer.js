/* Isolated, read-only Office renderer: no preload, network, forms or navigation. */
window.addEventListener('click', e => { if (e.target.closest('a')) e.preventDefault(); });
window.addEventListener('message', async e => {
  if (e.source !== parent || e.data?.type !== 'office-document') return;
  const { ext, bytes } = e.data;
  const content = document.getElementById('content'), status = document.getElementById('status');
  try {
    if (ext === 'docx') {
      await window.docx.renderAsync(bytes, content, null, { useBase64URL: true, renderAltChunks: false,
        breakPages: true, ignoreLastRenderedPageBreak: false });
      await document.fonts.ready;
      await Promise.all([...content.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
      paginateWord(content);
    } else if (ext === 'pptx') {
      const viewer = window.pptxPreview.init(content, { width: Math.max(320, document.documentElement.clientWidth - 32), height: Math.max(180, (document.documentElement.clientWidth - 32) * 9 / 16), mode: 'list' });
      await viewer.preview(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (!viewer.slideCount) { viewer.destroy(); await renderSlides(bytes, content); }
    } else {
      const workbook = new window.ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      const tabs = document.getElementById('tabs'); tabs.hidden = false;
      const show = sheet => {
        content.replaceChildren();
        for (const button of tabs.children) button.setAttribute('aria-pressed', String(button.textContent === sheet.name));
        const table = document.createElement('table');
        const rows = Math.min(sheet.rowCount, 2000), columns = Math.min(sheet.columnCount, 100);
        const colgroup = document.createElement('colgroup');
        for (let c=1;c<=columns;c++) {
          const col=document.createElement('col');
          col.style.width=Math.max(36, (sheet.getColumn(c).width || 12)*7+5)+'px';
          if(sheet.getColumn(c).hidden) col.style.visibility='collapse';
          colgroup.append(col);
        }
        table.append(colgroup);
        for (let r = 1; r <= rows; r++) {
          const tr = table.insertRow();
          const row=sheet.getRow(r);
          if(row.hidden)tr.hidden=true;
          if(row.height)tr.style.height=(row.height*4/3)+'px';
          for (let c = 1; c <= columns; c++) {
            const cell = sheet.getCell(r, c), td = tr.insertCell();
            if (cell.isMerged && cell.master.address !== cell.address) { td.remove(); continue; }
            td.textContent = formatCell(cell);
            if(cell.font?.name)td.style.fontFamily=cell.font.name;
            if(cell.font?.size)td.style.fontSize=cell.font.size+'pt';
            if(cell.font?.italic)td.style.fontStyle='italic';
            td.style.verticalAlign=cell.alignment?.vertical || 'middle';
            td.style.whiteSpace=cell.alignment?.wrapText?'pre-wrap':'pre';
            td.style.minWidth='0';
            if(sheet.views?.some(v=>v.showGridLines===false))td.style.border='0';
            for(const side of ['top','bottom','left','right']) {
              const border=cell.border?.[side];
              if(border?.style){const color=border.color?.argb?.slice(-6)||'DCE3E9';td.style['border'+side[0].toUpperCase()+side.slice(1)]=(border.style==='medium'?2:1)+'px solid #'+color;}
            }
            if (cell.font?.bold) td.style.fontWeight = 'bold';
            if (cell.font?.color?.argb) td.style.color = '#' + cell.font.color.argb.slice(-6);
            if (cell.fill?.fgColor?.argb) td.style.background = '#' + cell.fill.fgColor.argb.slice(-6);
            td.style.textAlign = cell.alignment?.horizontal || (typeof (cell.value?.result ?? cell.value) === 'number' ? 'right' : 'left');
            if (cell.value?.formula) td.title = '=' + cell.value.formula;
            for (const range of sheet.model.merges || []) {
              const [first, last] = range.split(':');
              if (first === cell.address) { const end = sheet.getCell(last); td.rowSpan = end.row - r + 1; td.colSpan = end.col - c + 1; }
            }
          }
        }
        content.append(table);
        status.textContent = `${sheet.name} · ${sheet.rowCount} 行 × ${sheet.columnCount} 列` + (rows < sheet.rowCount || columns < sheet.columnCount ? '（仅预览前 2000 行、100 列）' : '');
      };
      for (const sheet of workbook.worksheets) { const b = document.createElement('button'); b.textContent = sheet.name; b.onclick = () => show(sheet); tabs.append(b); }
      if (workbook.worksheets[0]) show(workbook.worksheets[0]);
    }
    if (ext !== 'xlsx') status.textContent = (ext === 'docx' ? `${content.querySelectorAll('.docx-wrapper > section.docx').length} 页 · ` : '') + '只读预览 · 复杂版式可能与 Office 有差异';
    parent.postMessage({ type: 'office-rendered', ext, text: content.textContent, nodes: content.childElementCount }, '*');
  } catch (error) { status.textContent = '预览失败：' + error.message; parent.postMessage({ type: 'office-rendered', error: error.message }, '*'); }
});
parent.postMessage({ type: 'office-ready' }, '*');

// docx-preview honors stored page breaks but does not paginate overflowing text.
// Measure at the document's fixed paper width after fonts/images have settled.
function paginateWord(content) {
  for (const original of [...content.querySelectorAll('.docx-wrapper > section.docx')]) {
    const style = getComputedStyle(original);
    const height = parseFloat(style.minHeight);
    if (!height) continue;
    const template = original.cloneNode(false);
    for (const node of original.children) if (['HEADER', 'FOOTER'].includes(node.tagName)) template.append(node.cloneNode(true));
    const articles = [...original.querySelectorAll(':scope > article')];
    if (!articles.length) continue;
    const blocks = articles.flatMap(article => [...article.children]);
    // Notes belong at the end of their original section, not on every new page.
    const notes = [...original.children].filter(node => !['HEADER', 'FOOTER', 'ARTICLE'].includes(node.tagName));
    blocks.push(...notes);
    const chromeHeight = [...original.querySelectorAll(':scope > header, :scope > footer')].reduce((total, node) => {
      const css = getComputedStyle(node);
      return total + node.getBoundingClientRect().height + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
    }, 0);
    const capacity = Math.max(1, height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - Math.max(0, chromeHeight));
    let page = original, article;
    const prepare = target => {
      for (const node of [...target.children]) if (!['HEADER', 'FOOTER'].includes(node.tagName)) node.remove();
      target.style.height = `${height}px`;
      // A single indivisible image/row may be larger than a page; retain it.
      target.style.overflow = 'visible';
      const body = articles[0].cloneNode(false);
      body.style.display = 'flow-root'; body.style.flexShrink = '0';
      target.insertBefore(body, target.querySelector(':scope > footer'));
      return body;
    };
    article = prepare(page);
    const nextPage = () => {
      const next = template.cloneNode(true);
      next.removeAttribute('id');
      page.after(next); page = next; article = prepare(page);
    };
    const fits = () => article.getBoundingClientRect().height <= capacity + 1;
    for (const block of blocks) {
      article.append(block);
      if (fits()) continue;
      if (article.childElementCount > 1) {
        block.remove(); nextPage(); article.append(block);
      }
      if (fits()) continue;
      if (block.tagName === 'P' && !block.querySelector('img, svg, math')) {
        let remainder = block;
        while (!fits()) {
          const part = splitWordParagraph(remainder, fits);
          if (!part) break;
          nextPage(); article.append(part); remainder = part;
        }
      } else if (block.tagName === 'TABLE') {
        let table = block;
        while (!fits() && table.rows.length > 1) {
          const tail = table.cloneNode(true);
          // Do not cut a vertically merged cell across pages.
          let count = table.rows.length;
          while (count > 1 && !fits()) { table.rows[count - 1].remove(); count--; }
          const safe = [...tail.rows].slice(0, count).every((row, index) => [...row.cells].every(cell => index + cell.rowSpan <= count));
          if (!safe) { table.replaceWith(tail); break; }
          for (let index = 0; index < count; index++) tail.rows[0].remove();
          if (!fits()) page.style.height = `${height + article.getBoundingClientRect().height - capacity}px`;
          nextPage(); article.append(tail); table = tail;
        }
      }
      // Keep oversized indivisible content readable without covering the next page.
      if (!fits()) page.style.height = `${height + article.getBoundingClientRect().height - capacity}px`;
    }
  }
}

function splitWordParagraph(paragraph, fits) {
  const text = paragraph.textContent;
  if (text.length < 2) return null;
  const rangeTo = offset => {
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (offset <= node.length) { range.setEnd(node, offset); break; }
      offset -= node.length;
    }
    return range;
  };
  const prefix = paragraph.cloneNode(false);
  paragraph.replaceWith(prefix);
  let low = 0, high = text.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    prefix.replaceChildren(rangeTo(middle).cloneContents());
    if (fits()) low = middle; else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  if (!low) { prefix.replaceWith(paragraph); return null; }
  prefix.replaceChildren(rangeTo(low).extractContents());
  paragraph.style.textIndent = '0'; paragraph.style.marginTop = '0';
  return paragraph;
}

// Basic OOXML fallback for decks the primary renderer cannot parse.
async function renderSlides(bytes, host) {
  const zip = await window.JSZip.loadAsync(bytes);
  const xml = async name => new DOMParser().parseFromString(await zip.file(name).async('string'), 'application/xml');
  const nodes = (el, name) => [...el.getElementsByTagNameNS('*', name)];
  const presentation = await xml('ppt/presentation.xml');
  const size = nodes(presentation, 'sldSz')[0];
  const width = Number(size?.getAttribute('cx')) || 12192000, height = Number(size?.getAttribute('cy')) || 6858000;
  const files = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  host.replaceChildren();
  const viewWidth = Math.max(320, document.documentElement.clientWidth - 32);
  for (const name of files) {
    const doc = await xml(name), slide = document.createElement('section');
    slide.style = `position:relative;width:${viewWidth}px;height:${viewWidth*height/width}px;background:white;margin:0 auto 20px;overflow:hidden;color:#222;box-shadow:0 2px 8px #0003`;
    const scale = viewWidth / width;
    const relName = name.replace('slides/', 'slides/_rels/') + '.rels';
    const rels = zip.file(relName) ? nodes(await xml(relName), 'Relationship') : [];
    for (const shape of [...nodes(doc, 'sp'), ...nodes(doc, 'pic'), ...nodes(doc, 'graphicFrame')]) {
      const off = nodes(shape, 'off')[0], ext = nodes(shape, 'ext').find(n => n.hasAttribute('cx'));
      if (!off || !ext) continue;
      const box = document.createElement('div');
      box.style = `position:absolute;box-sizing:border-box;overflow:hidden;left:${Number(off.getAttribute('x'))*scale}px;top:${Number(off.getAttribute('y'))*scale}px;width:${Number(ext.getAttribute('cx'))*scale}px;height:${Number(ext.getAttribute('cy'))*scale}px`;
      const fill = nodes(shape, 'spPr')[0]?.getElementsByTagNameNS('*','solidFill')[0];
      const rgb = fill && nodes(fill, 'srgbClr')[0]?.getAttribute('val');
      if (rgb && /^[0-9a-f]{6}$/i.test(rgb)) box.style.background = '#'+rgb;
      const blip = nodes(shape, 'blip')[0];
      if (blip) {
        const id = blip.getAttribute('r:embed'), target = rels.find(r => r.getAttribute('Id') === id)?.getAttribute('Target');
        if (target && !target.includes('://')) {
          const parts = ['ppt','slides',...target.split('/')], normalized=[];
          for (const part of parts) { if(part==='..')normalized.pop();else if(part!=='.')normalized.push(part); }
          const entry = zip.file(normalized.join('/'));
          if(entry) { const img=document.createElement('img');img.src='data:image/'+(target.endsWith('.jpg')?'jpeg':target.split('.').pop())+';base64,'+await entry.async('base64');img.style='width:100%;height:100%;object-fit:contain';box.append(img); }
        }
      } else {
        for (const para of nodes(shape, 'p')) {
          const line = document.createElement('div');
          const pp = nodes(para,'pPr')[0];line.style.textAlign = ({ctr:'center',r:'right'})[pp?.getAttribute('algn')] || 'left';
          for(const run of nodes(para,'r')) {
            const span=document.createElement('span');span.textContent=nodes(run,'t').map(t=>t.textContent).join('');
            const rp=nodes(run,'rPr')[0];span.style.fontSize=((Number(rp?.getAttribute('sz'))||1800)/100*12700*scale)+'px';
            if(rp?.getAttribute('b')==='1')span.style.fontWeight='bold';
            const color=rp&&nodes(rp,'srgbClr')[0]?.getAttribute('val');if(color&&/^[0-9a-f]{6}$/i.test(color))span.style.color='#'+color;
            line.append(span);
          }
          box.append(line);
        }
      }
      slide.append(box);
    }
    host.append(slide);
  }
  if(!files.length)throw Error('没有可显示的幻灯片');
}

// Display cached values with common Office number formats; never recalculate formulas.
function formatCell(cell) {
  const value=cell.value?.result ?? cell.value, fmt=cell.numFmt || '';
  if(value instanceof Date)return new Intl.DateTimeFormat('zh-CN').format(value);
  if(typeof value!=='number')return cell.text;
  if(!fmt || fmt==='General')return String(value);
  const section=fmt.split(';')[value<0?1:0] || fmt.split(';')[0];
  const decimals=(section.match(/\.([0#]+)/)?.[1] || '').length;
  const percent=section.includes('%');
  const text=new Intl.NumberFormat('zh-CN',{useGrouping:section.includes(','),minimumFractionDigits:decimals,maximumFractionDigits:decimals}).format(percent?value*100:value);
  const currency=section.match(/[¥￥$€£]/)?.[0] || '';
  return currency+text+(percent?'%':'');
}
// Sync only viewer chrome. Document colors are never inverted or themed.
function syncViewerTheme() {
  const style = parent.getComputedStyle(parent.document.documentElement);
  document.documentElement.style.colorScheme = style.colorScheme;
  document.documentElement.style.setProperty('--wallpaper-cover', style.getPropertyValue('--wallpaper-cover') || '.65');
  for (const name of ['--bg1','--panel-2','--hair','--txt','--txt-dim']) {
    document.documentElement.style.setProperty(name, style.getPropertyValue(name));
  }
}
syncViewerTheme();
const themeObserver = new MutationObserver(syncViewerTheme);
themeObserver.observe(parent.document.documentElement, { attributes: true, attributeFilter: ['data-theme','data-wallpaper','style'] });
window.addEventListener('pagehide', () => themeObserver.disconnect(), { once: true });
