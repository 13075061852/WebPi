module.exports = async ({PDFKit,fs,path,font}) => {
  const out=path.resolve('output');fs.mkdirSync(out,{recursive:true});
  if(!font)throw Error('缺少中文字体');
  const file=path.join(out,'report.pdf'),doc=new PDFKit({size:'A4',margin:54,info:{Title:'项目报告',Author:'Pi Halo'}});
  const stream=fs.createWriteStream(file);doc.pipe(stream);doc.font(font);
  const text=(s,x,y,size=11,color='#203449',width=487)=>doc.fontSize(size).fillColor(color).text(s,x,y,{width,lineGap:5});
  const rule=y=>doc.moveTo(54,y).lineTo(541,y).strokeColor('#DCE4E9').lineWidth(.6).stroke();
  const footer=n=>{rule(750);text('项目报告 · 演示数据',54,761,9,'#526477',400);text(String(n).padStart(2,'0'),510,761,9,'#526477',30);};
  text('项目报告',54,64,30);text('进展概览与交付安排',54,111,13,'#526477');rule(151);
  text('01 / 当前结论',54,177,16);
  text('基础能力已完成接入，下一阶段聚焦真实数据验证与交付检查。',54,216,17,'#203449',460);
  doc.rect(54,296,487,93).fill('#F1F6F5');
  text('本期重点',72,314,10,'#147D78');text('数据准确 · 版式清晰 · 文件可编辑',72,343,18,'#203449',445);
  text('工作进展',54,431,16);
  for(const [i,title,body] of [['01','文档生成','已接入四种办公格式，保留可编辑源文件。'],['02','内容验证','校验文件结构、关键数字及中文显示。'],['03','交付准备','替换演示数据，检查实际文件的视觉效果。']]){
    const y=474+(Number(i)-1)*75;text(i,54,y,11,'#147D78',36);text(title,100,y,12);text(body,100,y+24,10,'#526477',435);rule(y+61);
  }
  footer(1);doc.addPage();
  text('下一步行动',54,64,28);text('将检查结果转化为可执行的交付安排',54,110,12,'#526477');rule(150);
  [['替换真实数据','逐项核对来源、单位和时间范围，明确待确认的假设。'],['检查完整版式','查看实际渲染页面，修复长文本截断、对齐及分页问题。'],['交付并说明边界','提供原生文件与阅读版本，注明尚未完成的检查。']].forEach(([title,body],i)=>{const y=192+i*134;text('0'+(i+1),54,y,21,'#147D78',45);text(title,114,y,17);text(body,114,y+38,11,'#526477',400);rule(y+103);});
  text('说明',54,648,12);text('本文件为版式示例，不代表真实项目状态。正式报告应根据实际内容调整章节与页面数量。',54,677,10,'#526477');footer(2);
  doc.end();await new Promise((resolve,reject)=>{stream.on('finish',resolve);stream.on('error',reject);doc.on('error',reject);});return {files:[file]};
};

