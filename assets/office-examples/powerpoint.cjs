module.exports = async ({PptxGenJS,fs,path}) => {
  const out=path.resolve('output');fs.mkdirSync(out,{recursive:true});
  const ppt=new PptxGenJS();ppt.layout='LAYOUT_WIDE';ppt.author='Pi Halo';ppt.subject='演示数据';ppt.title='项目成果汇报';
  ppt.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei',lang:'zh-CN'};
  ppt.defineSlideMaster({title:'CONTENT',background:{color:'F6F8FA'},objects:[{text:{text:'项目成果汇报 · 演示数据',options:{x:.5,y:.2,w:12,h:.3,fontSize:10,color:'627D98'}}}],slideNumber:{x:12,y:7,w:.5,h:.2,color:'627D98',fontSize:10}});
  let slide=ppt.addSlide('CONTENT');slide.addShape(ppt.ShapeType.rect,{x:.7,y:1.45,w:.65,h:.07,fill:{color:'147D78'},line:{color:'147D78'}});slide.addText('项目成果汇报',{x:.7,y:2,w:11.9,h:.8,fontSize:40,bold:true,color:'203449'});slide.addText('围绕进度、成果与下一步行动',{x:.7,y:3.1,w:11,h:.6,fontSize:22,color:'526477'});
  slide=ppt.addSlide('CONTENT');slide.addText('阶段进展',{x:.7,y:.8,w:11,h:.6,fontSize:28,bold:true,color:'203449'});
  slide.addChart(ppt.ChartType.bar,[{name:'完成任务',labels:['第一阶段','第二阶段','第三阶段'],values:[12,18,24]}],{x:.7,y:1.7,w:11.8,h:4.7,showLegend:false,showValue:true,catAxisLabelFontSize:14,valAxisLabelFontSize:12,chartColors:['147D78']});
  slide=ppt.addSlide('CONTENT');slide.addText('后续行动',{x:.7,y:.8,w:11,h:.6,fontSize:28,bold:true,color:'203449'});slide.addTable([['行动','负责人','期限'],['替换真实数据','项目组','待确认'],['逐页检查排版','编写者','交付前']],{x:.7,y:1.8,w:11.8,h:2.8,border:{type:'solid',color:'E0E6EB',pt:.5},fontFace:'Microsoft YaHei',fontSize:20,color:'203449',fill:'FFFFFF',margin:.15});
  const file=path.join(out,'presentation.pptx');await ppt.writeFile({fileName:file});return {files:[file]};
};
