const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const JSZip = require('jszip');
// Restrict the optional image-size decoder to standard document image types.
const imageSize = require('image-size');
imageSize.disableTypes(imageSize.types.filter(type => !['png','jpg','gif','svg','webp','bmp'].includes(type))); 
const { XMLValidator } = require('fast-xml-parser');
const LIMIT = 64 * 1024 * 1024;
const fontPaths = [process.env.HALO_DOCUMENT_FONT, 'C:/Windows/Fonts/simhei.ttf', '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf'].filter(Boolean);
const font = fontPaths.find(p => fs.existsSync(p)) || null;
async function inspect(file) {
  if (fs.statSync(file).size > LIMIT) throw Error('文档超过 64 MB 检查上限');
  const data = fs.readFileSync(file), ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    const pdf = await require('pdf-lib').PDFDocument.load(data);
    return { file, type: 'pdf', pages: pdf.getPageCount(), bytes: data.length, validation: 'structure', visualChecked: false };
  }
  if (!['.docx','.xlsx','.pptx'].includes(ext)) throw Error('支持 PDF、DOCX、XLSX、PPTX');
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files);
  if (names.length > 10000) throw Error('文档 ZIP 条目过多');
  const expected = {'.docx':'word/document.xml','.xlsx':'xl/workbook.xml','.pptx':'ppt/presentation.xml'}[ext];
  if (!zip.file('[Content_Types].xml') || !zip.file(expected)) throw Error('文件不是有效的 Office 文档');
  let text = '', expanded = 0;
  for (const name of names.filter(n => /\.xml$/.test(n))) {
    const entry = zip.files[name];
    if (entry._data?.uncompressedSize > LIMIT) throw Error('文档 XML 过大');
    const xml = await entry.async('string'); expanded += Buffer.byteLength(xml);
    if (expanded > LIMIT) throw Error('文档 XML 总量超过检查上限');
    const valid = XMLValidator.validate(xml);
    if (valid !== true) throw Error('XML 损坏：' + name + ' ' + valid.err.msg);
    if (/^(word\/document|ppt\/slides\/slide\d+|xl\/sharedStrings)\.xml$/.test(name)) text += xml.replace(/<[^>]*>/g, ' ').replace(/\s+/g,' ').slice(0, Math.max(0,12000-text.length));
  }
  const report = {file, type:ext.slice(1),bytes:data.length,validation:'structure',visualChecked:false,text:text.slice(0,12000)};
  if (ext === '.pptx') report.slides = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  if (ext === '.xlsx') {
    const book = new (require('exceljs').Workbook)(); await book.xlsx.load(data);
    const formulaWarnings = [];
    report.sheets = book.worksheets.map(sheet => {
      sheet.eachRow(row => row.eachCell(cell => {
        if (cell.type === 6 && cell.value.result === undefined) formulaWarnings.push(sheet.name + '!' + cell.address + ': formula has no cached result');
        if (cell.value?.error) formulaWarnings.push(sheet.name + '!' + cell.address + ': ' + cell.value.error);
      }));
      return {name:sheet.name,rows:sheet.rowCount,columns:sheet.columnCount};
    });
    report.formulaWarnings = formulaWarnings.slice(0,100);
    report.calculated = false;
  }
  return report;
}
async function renderPDF(file, outputDir, maxPages = 12, startPage = 1) {
  if(fs.statSync(file).size>LIMIT)throw Error("PDF 超过 64 MB 上限");
  const canvasLib = require('@napi-rs/canvas');
  for (const key of ['DOMMatrix','ImageData','Path2D']) globalThis[key] ??= canvasLib[key];
  const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts:true });
  const pdf = await task.promise;
  fs.mkdirSync(outputDir,{recursive:true});
  const images=[], texts=[];
  try {
    for(let i=startPage;i<=Math.min(pdf.numPages,startPage+maxPages-1);i++) {
      const page=await pdf.getPage(i), viewport=page.getViewport({scale:1.3});
      if(viewport.width*viewport.height>20000000)throw Error('PDF 页面像素过大');
      const canvas=canvasLib.createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const image=path.join(outputDir,'page-'+i+'.png');fs.writeFileSync(image,canvas.toBuffer('image/png'));images.push(image);
      const text=await page.getTextContent();texts.push(text.items.map(i=>i.str).join(' ').slice(0,12000));
      page.cleanup();
    }
    return {pages:pdf.numPages,rendered:images.length,images,texts,visualChecked:false};
  } finally {await task.destroy();}
}
async function main(args) {
  if(args.action==='inspect')return inspect(path.resolve(args.file));
  if(args.action==='render_pdf')return renderPDF(path.resolve(args.file),path.resolve(args.outputDir||'output/pdf-preview'),Math.max(1,Math.min(50,args.maxPages||12)),Math.max(1,args.startPage||1));
  if(args.action==='status')return {formats:['pdf','docx','xlsx','pptx'],font,officeRequired:false,convertPDF:{action:'convert_pdf',formats:['docx','xlsx','pptx'],engine:'Microsoft Office on Windows',timeoutSeconds:60,overwrite:false},renderPDF:true,imageDecoders:'PNG/JPEG/GIF/SVG/WebP/BMP only; ICNS/JXL/HEIF disabled',officeVisualEngine:'External LibreOffice or Microsoft Office required for faithful Office pagination',libraries:['docx','exceljs','pptxgenjs','pdfkit','pdf-lib','jszip','fast-xml-parser','pdfjs-dist']};
  if(args.action!=='run')throw Error('未知操作');
  const api={fs,path,JSZip,font,inspect,renderPDF};
  for (const [name,module] of Object.entries({docx:'docx',ExcelJS:'exceljs',PptxGenJS:'pptxgenjs',PDFKit:'pdfkit',PDFLib:'pdf-lib',XML:'fast-xml-parser'})) {
    Object.defineProperty(api,name,{enumerable:true,get:()=>require(module)});
  }
  const builder=require(path.resolve(args.script));
  if(typeof builder!=='function')throw Error('脚本必须 module.exports = async (office) => {...}');
  const result=await builder(api);
  const checks=[];
  for(const file of result?.files||[])checks.push(await inspect(path.resolve(file)));
  return {result,checks};
}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.length>1000000)throw Error('请求过大');});
process.stdin.on('end',()=>main(JSON.parse(input)).then(result=>process.stdout.write('\nHALO_OFFICE_RESULT='+JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;}));
