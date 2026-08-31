(function(){
var st=document.getElementById("__halo-touch");
if(!st){st=document.createElement("style");st.id="__halo-touch";document.documentElement.appendChild(st);}
st.textContent="::-webkit-scrollbar{width:0!important;height:0!important}html{scrollbar-width:none!important}html{cursor:grab}html.halo-drag,html.halo-drag *{cursor:grabbing!important}html{scroll-behavior:auto!important}body{overscroll-behavior:contain}";
window.__haloTouchOn=true;
if(window.__haloTouchInstalled)return;
window.__haloTouchInstalled=true;
if(window.innerWidth<=430){var hs=document.createElement("style");hs.textContent="body::after{content:'';position:fixed;bottom:7px;left:50%;transform:translateX(-50%);width:118px;height:5px;border-radius:3px;background:rgba(0,0,0,.16);z-index:2147483647;pointer-events:none}";document.documentElement.appendChild(hs);}
var dragSc=null,sx=0,sy=0,cx=0,cy=0,bx=0,by=0,rafD=0,rafG=0,rafB=0,samples=[],moved=false,osT=0;
var rootSc=function(){return document.scrollingElement||document.documentElement;};
function isRoot(s){return s===rootSc()||s===document.documentElement;}
function scrollerAt(t){
 var de=rootSc();
 if(de.scrollHeight>de.clientHeight+1)return de;
 var cur=t;
 while(cur&&cur!==de){
  var s=getComputedStyle(cur);
  if(/(auto|scroll|overlay)/.test(s.overflowY)&&cur.scrollHeight>cur.clientHeight+1)return cur;
  cur=cur.parentElement;
 }
 return null;
}
function limits(sc){
 if(isRoot(sc)){var de=rootSc();return{maxT:Math.max(0,de.scrollHeight-window.innerHeight),maxL:Math.max(0,de.scrollWidth-window.innerWidth)};}
 return{maxT:Math.max(0,sc.scrollHeight-sc.clientHeight),maxL:Math.max(0,sc.scrollWidth-sc.clientWidth)};
}
function setScroll(sc,t,l){if(isRoot(sc)){window.scrollTo({top:t,left:l,behavior:"instant"});}else{sc.scrollTop=t;sc.scrollLeft=l;}}
function getScroll(sc){if(isRoot(sc))return{top:window.scrollY,left:window.scrollX};return{top:sc.scrollTop,left:sc.scrollLeft};}
function setOs(v){
 osT=v;var de=rootSc();
 if(v)de.style.transform="translateY("+v+"px)";else de.style.transform="";
 try{parent.postMessage({__haloOs:{v:Math.round(v*10)/10,dy:Math.round((cy-sy)*10)/10,by:Math.round(by*10)/10}},"*")}catch(e){}
}
function dragFrame(){
 if(!dragSc)return;
 var dx=cx-sx,dy=cy-sy;
 var lm=limits(dragSc);
 var rawT=by-dy,rawL=bx-dx;
 var t=rawT,l=rawL,os=0;
 if(isRoot(dragSc)){
  if(rawT<0)os=rawT*0.3;else if(rawT>lm.maxT)os=(rawT-lm.maxT)*0.3;
  if(os!==osT)setOs(os);
 }
 t=Math.max(0,Math.min(lm.maxT,rawT));l=Math.max(0,Math.min(lm.maxL,rawL));
 setScroll(dragSc,t,l);
 rafD=requestAnimationFrame(dragFrame);
}
function releaseVelocity(){
 if(samples.length<2)return{x:0,y:0};
 var i=samples.length-1;
 while(i>0&&samples[i].t-samples[i-1].t<60)i--;
 var f=samples[i],ll=samples[samples.length-1],dt=ll.t-f.t;
 if(dt<10)return{x:0,y:0};
 var vx=(ll.x-f.x)/dt*16.7,vy=(ll.y-f.y)/dt*16.7;
 var m=Math.sqrt(vx*vx+vy*vy);
 if(m>65){vx*=65/m;vy*=65/m;}
 return{x:vx,y:vy};
}
function glide(sc,vx,vy){
 var lt=performance.now();
 var rep=function(){try{parent.postMessage({__haloScroll:{y:isRoot(sc)?window.scrollY:sc.scrollTop,ph:2}},"*")}catch(e){}};
 var step=function(){
  var t=performance.now(),dms=t-lt;lt=t;
  var k=Math.pow(0.965,dms/16.7);
  vx*=k;vy*=k;
  var lm=limits(sc),st=getScroll(sc);
  var nt=st.top-vy*dms/16.7,nl=st.left-vx*dms/16.7;
  if(nt<=0){nt=0;vy=0;}else if(nt>=lm.maxT){nt=lm.maxT;vy=0;}
  if(nl<=0){nl=0;vx=0;}else if(nl>=lm.maxL){nl=lm.maxL;vx=0;}
  setScroll(sc,nt,nl);
  if(vx*vx+vy*vy>0.04)rafG=requestAnimationFrame(step);else rep();
 };
 rafG=requestAnimationFrame(step);
}
function bounceBack(){
 if(Math.abs(osT)<0.5){setOs(0);return;}
 setOs(osT*0.8);
 rafB=requestAnimationFrame(bounceBack);
}
function pushSample(x,y){var t=performance.now();samples.push({t:t,x:x,y:y});while(samples.length>2&&t-samples[0].t>120)samples.shift();}
document.addEventListener("pointerdown",function(e){
 if(!window.__haloTouchOn||e.button!==0)return;
 var sc=scrollerAt(e.target);
 if(!sc)return;
 cancelAnimationFrame(rafG);cancelAnimationFrame(rafD);cancelAnimationFrame(rafB);
 dragSc=sc;moved=false;samples=[];
 sx=e.clientX;sy=e.clientY;cx=sx;cy=sy;
 var st=getScroll(sc);bx=st.left;by=st.top;
 setOs(0);
 document.documentElement.style.cursor="grabbing";document.body.style.cursor="grabbing";
 if(e.target.setPointerCapture){try{e.target.setPointerCapture(e.pointerId)}catch(err){}}
 document.documentElement.classList.add("halo-drag");
 pushSample(cx,cy);
 rafD=requestAnimationFrame(dragFrame);
},true);
document.addEventListener("pointermove",function(e){
 if(!dragSc)return;
 cx=e.clientX;cy=e.clientY;
 if(!moved&&(cx-sx)*(cx-sx)+(cy-sy)*(cy-sy)>16)moved=true;
 pushSample(cx,cy);
},true);
function endDrag(e,withGlide){
 if(!dragSc)return;
 cancelAnimationFrame(rafD);
 var sc=dragSc;dragSc=null;
 if(e.target.releasePointerCapture){try{e.target.releasePointerCapture(e.pointerId)}catch(err){}}
 document.documentElement.classList.remove("halo-drag");
 document.documentElement.style.cursor="";document.body.style.cursor="";
 if(osT!==0)bounceBack();
 if(!moved)return;
 var rep=function(){try{parent.postMessage({__haloScroll:{y:isRoot(sc)?window.scrollY:sc.scrollTop,ph:1}},"*")}catch(e2){}};
 var v=releaseVelocity();
 rep();
 var kill=function(ev){ev.stopPropagation();ev.preventDefault();};
 document.addEventListener("click",kill,true);
 setTimeout(function(){document.removeEventListener("click",kill,true);},80);
 if(withGlide&&(Math.abs(v.x)>0.5||Math.abs(v.y)>0.5))glide(sc,v.x,v.y);
}
document.addEventListener("pointerup",function(e){endDrag(e,true);},true);
document.addEventListener("pointercancel",function(e){endDrag(e,false);},true);
document.addEventListener("selectstart",function(e){if(dragSc&&e.cancelable)e.preventDefault();},true);
document.addEventListener("dragstart",function(e){if(dragSc&&e.cancelable)e.preventDefault();},true);
})();
