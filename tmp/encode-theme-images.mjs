import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
const entries=JSON.parse(fs.readFileSync('tmp/theme-generated-manifest.json','utf8'));
let originals=0, encoded=0, thumbnails=0;
for(const {id,source} of entries){
 const image=await loadImage(source);
 const canvas=createCanvas(image.width,image.height);
 canvas.getContext('2d').drawImage(image,0,0);
 const full=await canvas.encode('webp',90);
 fs.writeFileSync(`assets/themes/collection/scene-${id}.webp`,full);
 const thumb=createCanvas(480,Math.round(480*image.height/image.width));
 thumb.getContext('2d').drawImage(image,0,0,thumb.width,thumb.height);
 const small=await thumb.encode('webp',82);
 fs.writeFileSync(`assets/themes/collection/scene-${id}-thumb.webp`,small);
 originals+=fs.statSync(source).size;encoded+=full.length;thumbnails+=small.length;
}
console.log(JSON.stringify({count:entries.length,originals,encoded,thumbnails}));
