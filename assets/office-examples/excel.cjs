module.exports = async ({ExcelJS,fs,path}) => {
  const out=path.resolve('output');fs.mkdirSync(out,{recursive:true});
  const book=new ExcelJS.Workbook();book.creator='Pi Halo';book.calcProperties.fullCalcOnLoad=true;
  const sheet=book.addWorksheet('预算',{views:[{state:'frozen',ySplit:6,showGridLines:false}]});
  sheet.columns=[{width:28},{width:14},{width:20},{width:22}];
  sheet.mergeCells('A1:D1');sheet.getCell('A1').value='项目预算';
  sheet.mergeCells('A2:D2');sheet.getCell('A2').value='预算概览与费用明细 · 演示数据';
  sheet.mergeCells('A4:B4');sheet.getCell('A4').value='预算总额 / 元';
  sheet.mergeCells('C4:D4');sheet.getCell('C4').value={formula:'D10',result:15400};
  sheet.getRow(6).values=['费用项目','数量','单价 / 元','金额 / 元'];
  [['设计',2,1500],['开发',5,2000],['测试',3,800]].forEach((row,i)=>{
    sheet.getRow(i+7).values=[...row,{formula:`B${i+7}*C${i+7}`,result:row[1]*row[2]}];
  });
  sheet.getRow(10).values=['合计',null,null,{formula:'SUM(D7:D9)',result:15400}];
  sheet.mergeCells('A12:D12');sheet.getCell('A12').value='填写说明';
  sheet.mergeCells('A13:D13');sheet.getCell('A13').value='浅绿色单元格为可编辑输入，金额保留计算公式。正式使用前请替换演示数据。';
  sheet.eachRow(row=>{row.height=30;row.font={name:'Microsoft YaHei',size:11,color:{argb:'FF203449'}};row.alignment={vertical:'middle',wrapText:true};});
  sheet.getRow(1).height=46;sheet.getCell('A1').font={name:'Microsoft YaHei',size:24,bold:true,color:{argb:'FF203449'}};
  sheet.getCell('A2').font={name:'Microsoft YaHei',size:10,color:{argb:'FF526477'}};
  sheet.getRow(4).height=52;sheet.getCell('C4').font={name:'Microsoft YaHei',size:26,bold:true,color:{argb:'FF147D78'}};
  for(const n of [4,6])sheet.getRow(n).eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:n===4?'FFF1F6F5':'FF203449'}};if(n===6)c.font={name:'Microsoft YaHei',size:11,bold:true,color:{argb:'FFFFFFFF'}};});
  for(let r=7;r<=9;r++)for(let c=1;c<=4;c++){
    const cell=sheet.getCell(r,c);cell.border={bottom:{style:'hair',color:{argb:'FFE3E8ED'}}};
    if(c===2||c===3){cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFEDF6F3'}};cell.font={name:'Microsoft YaHei',size:11,color:{argb:'FF147D78'}};}
  }
  sheet.getRow(10).eachCell({includeEmpty:true},c=>{c.font={name:'Microsoft YaHei',size:12,bold:true,color:{argb:'FF203449'}};c.border={top:{style:'thin',color:{argb:'FF9AABB8'}}};});
  sheet.getRow(13).height=42;sheet.getCell('A13').font={name:'Microsoft YaHei',size:10,color:{argb:'FF526477'}};
  sheet.autoFilter='A6:D9';sheet.getColumn(3).numFmt='#,##0.00';sheet.getColumn(4).numFmt='#,##0.00';
  sheet.dataValidations.add('B7:B9',{type:'whole',operator:'greaterThanOrEqual',formulae:[0],showErrorMessage:true,error:'数量不能为负数'});
  sheet.pageSetup={paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printArea:'A1:D13',margins:{left:.35,right:.35,top:.45,bottom:.45,header:.2,footer:.2}};
  const file=path.join(out,'budget.xlsx');await book.xlsx.writeFile(file);return {files:[file],verifiedTotal:15400};
};
