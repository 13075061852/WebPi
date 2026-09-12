import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const categories=[
 ['nature','山野自然',[
 ['pine','松间晨光',['#bcd8cc','#f3e6bc','#789c87','#335c4f'],'light'],['alpine','雪岭晴空',['#81b6d5','#e6eef0','#7799b7','#344f71'],'light'],['canyon','赤岩峡谷',['#dba982','#f5dcad','#bf775c','#714342'],'light'],['meadow','旷野春风',['#b5d6c4','#f0efcb','#7da576','#38685f'],'light'],['autumn','秋山远行',['#d8b290','#f5e7c6','#b97742','#644a44'],'light'],['forest','幽林夜雨',['#142c39','#355460','#22434b','#0b232e'],'dark']]],
 ['water','海岸水域',[
 ['lagoon','碧湾浅滩',['#a0cfce','#e3ecdb','#58a7a5','#2e737c'],'light'],['tide','暮色潮汐',['#635879','#dfa691','#766b9b','#303d64'],'dark'],['island','白沙群岛',['#98cbde','#e5f0de','#559cae','#2d667e'],'light'],['lake','湖光镜影',['#adbcda','#f0d7c2','#8598b7','#475b80'],'light'],['polar','冰海极光',['#0a233c','#285765','#327b86','#133651'],'dark'],['coast','灯塔长夜',['#162539','#526277','#30465e','#102333'],'dark']]],
 ['city','城市夜色',[
 ['metro','霓虹街角',['#171b3d','#67537e','#353552','#101b33'],'dark'],['harbor','港湾蓝调',['#15334c','#b07c77','#456079','#162c44'],'dark'],['rooftop','天台落日',['#514367','#e69e87','#665476','#2e304f'],'dark'],['raincity','雨夜微光',['#112936','#456b79','#294251','#112533'],'dark'],['skyline','云端都会',['#21394d','#9699a7','#51667c','#172d41'],'dark'],['midnight','午夜车站',['#1c2437','#66526a','#3d3c55','#161f32'],'dark']]],
 ['cosmos','宇宙幻想',[
 ['orbit','环星漫游',['#0c1837','#363566','#334775','#101b40'],'dark'],['nebularose','玫瑰星云',['#25132e','#7e466e','#523b71','#211a40'],'dark'],['lunar','月面静海',['#17233b','#627797','#69758e','#25364f'],'dark'],['stardust','金色星尘',['#192638','#766447','#615948','#1c2d43'],'dark'],['eclipse','日蚀之环',['#111827','#554541','#50444f','#162133'],'dark'],['comet','彗尾流光',['#102d39','#326b7d','#376679','#122f4b'],'dark']]],
 ['oriental','东方意境',[
 ['ink','水墨远山',['#d6ded8','#f4efdf','#9aafa8','#4a706a'],'light'],['bamboo','竹窗听雨',['#c3d0b9','#eeecd3','#8eaa8d','#476e60'],'light'],['lotus','荷塘清夏',['#c2d5cb','#eeead5','#7fa89d','#416f69'],'light'],['plum','雪映红梅',['#d5dce0','#f4e9df','#a9b7bd','#606c7b'],'light'],['moon','青山望月',['#142d40','#4d737b','#325662','#152e42'],'dark'],['sands','敦煌流沙',['#d5ac7c','#f3dfbb','#c29469','#916049'],'light']]]
];
const out=path.join(root,'assets/themes/collection');fs.mkdirSync(out,{recursive:true});
const palettes={};let css='',html='<div class="theme-base-modes"><button class="mini-btn" data-theme-choice="light">浅色</button><button class="mini-btn" data-theme-choice="dark">深色</button></div><div class="theme-tabs" role="tablist" aria-label="主题分类">';
for(const [id,label] of categories)html+=`<button type="button" role="tab" id="theme-tab-${id}" aria-controls="theme-panel-${id}" aria-selected="false" tabindex="-1" data-theme-tab="${id}">${label}</button>`;
html+='</div>';
for(const [category,,themes] of categories){
 html+=`<div role="tabpanel" id="theme-panel-${category}" aria-labelledby="theme-tab-${category}" data-theme-panel="${category}" hidden class="theme-choices">`;
 for(const [slug,name,c,mode] of themes){
  const id='scene-'+slug;palettes[id]=mode;
  if(!fs.existsSync(path.join(out,id+'.webp')) || !fs.existsSync(path.join(out,id+'-thumb.webp'))) throw Error('Missing generated wallpaper: '+id);
  const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(',');
  const base=mode==='light'?c[1]:c[0],txt=mode==='light'?c[3]:'#edf1f4',dim=mode==='light'?c[3]:'#b6c5d2';
  css+=`:root[data-wallpaper="${id}"] { --wallpaper:url('../../../assets/themes/collection/${id}.webp'); --veil:rgba(${rgb(base)},calc(.18 * var(--wallpaper-cover,.65))); --bg0:${base}; --bg1:rgba(${rgb(base)},calc(.88 * var(--wallpaper-cover,.65))); --panel:${base}; --panel-2:rgba(${rgb(base)},calc(.94 * var(--wallpaper-cover,.65))); --txt:${txt}; --txt-dim:${dim}; --txt-faint:${dim}; --acc:${mode==='light'?c[3]:c[1]}; --acc-ink:${base}; --hair:${mode==='light'?'#304c4824':'#cedae624'}; --hair-2:${mode==='light'?'#304c4845':'#cedae645'}; }\n.wallpaper-sample.${id} { background-image:url('../../../assets/themes/collection/${id}-thumb.webp'); }\n`;
  html+=`<button class="theme-choice wallpaper-choice" data-theme-choice="${id}"><span class="theme-sample wallpaper-sample ${id}"><i></i><i></i><i></i></span><span>${name}</span></button>`;
 }
 html+='</div>';
}
fs.writeFileSync(path.join(root,'src/renderer/js/theme-catalog.js'),'window.HALO_THEME_PALETTES = '+JSON.stringify(palettes,null,2)+';\n');
fs.writeFileSync(path.join(root,'src/renderer/css/theme-collection.css'),css+'\n.theme-base-modes{display:flex;gap:8px;margin-bottom:16px}.theme-tabs{overflow-x:auto}.theme-tabs button{white-space:nowrap}\n');
const file=path.join(root,'src/renderer/index.html');let doc=fs.readFileSync(file,'utf8');const start=doc.includes('<div class="theme-base-modes"')?doc.indexOf('<div class="theme-base-modes"'):doc.indexOf('<div class="theme-tabs"'),end=doc.indexOf('<div class="set-pane" id="setPane-usage">',start);if(start<0||end<0)throw Error('Theme markup not found');doc=doc.slice(0,start)+html+'</div></div></div>\n      '+doc.slice(end);if(!doc.includes('js/theme-catalog.js'))doc=doc.replace('<script src="js/theme.js">','<script src="js/theme-catalog.js"></script>\n<script src="js/theme.js">');if(!doc.includes('css/theme-collection.css'))doc=doc.replace('</head>','<link rel="stylesheet" href="css/theme-collection.css">\n</head>');fs.writeFileSync(file,doc);
console.log('Built 5 categories and 30 ImageGen wallpaper palettes');
