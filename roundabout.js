/* A deliberately conservative, pen-up recognizer for approach → loop → exit.
 * Detection uses physical pixels; generated controls use the editor's normalized
 * coordinates. Original ink is never changed by this module.
 */
(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.RoundaboutGeometry=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const TAU=Math.PI*2;
 const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
 const gap=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
 const angle=(a,c)=>Math.atan2(a.y-c.y,a.x-c.x);
 const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
 const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
 function size(options){
  const {width,height}=options||{};
  return Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0?{width,height}:null;
 }
 function resample(points,count){
  const lengths=[0];
  for(let i=1;i<points.length;i++)lengths.push(lengths[i-1]+gap(points[i-1],points[i]));
  const total=lengths.at(-1);if(!total)return [];
  let j=1;
  return Array.from({length:count},(_,i)=>{
   const d=total*i/(count-1);while(j<points.length-1&&lengths[j]<d)j++;
   return mix(points[j-1],points[j],(d-lengths[j-1])/(lengths[j]-lengths[j-1]||1));
  });
 }
 // Center the fit first so the small 2×2 system stays well conditioned.
 function circle(points,start,end){
  const n=end-start+1;let x=0,y=0;
  for(let i=start;i<=end;i++){x+=points[i].x;y+=points[i].y}x/=n;y/=n;
  let xx=0,xy=0,yy=0,xr=0,yr=0;
  for(let i=start;i<=end;i++){
   const u=points[i].x-x,v=points[i].y-y,r=u*u+v*v;
   xx+=u*u;xy+=u*v;yy+=v*v;xr+=u*r;yr+=v*r;
  }
  const determinant=xx*yy-xy*xy;if(determinant<1e-6)return null;
  const cx=(xr*yy-yr*xy)/(2*determinant),cy=(yr*xx-xr*xy)/(2*determinant);
  const center={x:x+cx,y:y+cy};let radius=0;
  for(let i=start;i<=end;i++)radius+=gap(points[i],center);radius/=n;
  let error=0,maximum=0,total=0,backward=0;
  for(let i=start;i<=end;i++){
   const difference=Math.abs(gap(points[i],center)-radius)/radius;
   error+=difference*difference;maximum=Math.max(maximum,difference);
   if(i>start)total+=wrap(angle(points[i],center)-angle(points[i-1],center));
  }
  const direction=total>=0?1:-1;
  for(let i=start+1;i<=end;i++)backward+=Math.max(0,-direction*wrap(angle(points[i],center)-angle(points[i-1],center)));
  return {center,radius,error:Math.sqrt(error/n),maximum,turn:Math.abs(total),backward,direction};
 }
 function polygonLike(points,start,end){
  // Four long straight sides also fit a circle fairly well. Compare local
  // headings across a fixed arc-length window to reject box-shaped loops.
  const loop=resample(points.slice(start,end+1),41);let flat=0,reversed=0;
  for(let i=2;i<loop.length-2;i++){
   const a=Math.atan2(loop[i].y-loop[i-2].y,loop[i].x-loop[i-2].x);
   const b=Math.atan2(loop[i+2].y-loop[i].y,loop[i+2].x-loop[i].x);
   const turn=Math.abs(wrap(b-a));
   if(turn<.075)flat++;
   if(turn>1.6)reversed++;
  }
  return flat>13||reversed>2;
 }
 function tail(points,start,end,center,radius){
  let length=0,backward=0;
  for(let i=start+1;i<=end;i++){
   length+=gap(points[i],points[i-1]);
   backward+=Math.max(0,gap(points[i-1],center)-gap(points[i],center));
  }
  const chord=gap(points[start],points[end]);
  return {length,chord,backward:backward/radius};
 }
 function detect(input,options){
  const dimensions=size(options);if(!dimensions||!Array.isArray(input)||input.length<12)return null;
  const {width,height}=dimensions,minSize=Math.min(width,height),physical=[];
  for(const p of input){
   if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y))return null;
   const q={x:p.x*width,y:p.y*height};
   if(!physical.length||gap(q,physical.at(-1))>.05)physical.push(q);
  }
  if(physical.length<12)return null;
  let length=0;for(let i=1;i<physical.length;i++)length+=gap(physical[i],physical[i-1]);
  if(length<minSize*.48||length>minSize*8)return null;
  const sampled=resample(physical,Math.min(260,Math.max(72,Math.ceil(length/3))));
  const points=sampled.map((p,i)=>i&&i<sampled.length-1?{x:(sampled[i-1].x+p.x*2+sampled[i+1].x)/4,y:(sampled[i-1].y+p.y*2+sampled[i+1].y)/4}:p);
  const step=length/(points.length-1);let best=null;
  for(let i=3;i<points.length-30;i+=2){
   for(let j=i+24;j<points.length-3;j+=2){
    const travelled=(j-i)*step;
    if(travelled<minSize*.34||gap(points[i],points[j])>travelled*.07)continue;
    const fit=circle(points,i,j);if(!fit)continue;
    if(fit.radius<Math.max(12,minSize*.055)||fit.radius>minSize*.40||fit.error>.145||fit.maximum>.34||fit.turn<5.7||fit.turn>6.9||fit.backward>.6)continue;
    if(polygonLike(points,i,j))continue;
    const {center,radius}=fit;
    // Both open tails distinguish the full one-stroke instruction from a
    // standalone circle or a U-turn. Include modestly rough/retraced ring ink.
    let start=i,end=j;
    while(start>0&&gap(points[start-1],center)<radius*1.27&&gap(points[start-1],center)>radius*.63)start--;
    while(end<points.length-1&&gap(points[end+1],center)<radius*1.27&&gap(points[end+1],center)>radius*.63)end++;
    if(start<2||end>points.length-3)continue;
    if(gap(points[0],center)<radius*1.5||gap(points.at(-1),center)<radius*1.5)continue;
    if(start*step<Math.max(13,radius*.3)||(points.length-1-end)*step<Math.max(13,radius*.3))continue;
    const entryTail=tail(points,0,start,center,radius),exitTail=tail(points,end,points.length-1,center,radius);
    if(entryTail.length>entryTail.chord*1.45||exitTail.length>exitTail.chord*1.45||exitTail.backward>.25)continue;
    // Across the whole ring the hand may repeat part of the lap, but it must
    // still travel predominantly in one direction, not scribble back and forth.
    let turn=0,backward=0;
    for(let k=start+1;k<=end;k++){
     const delta=fit.direction*wrap(angle(points[k],center)-angle(points[k-1],center));
     turn+=delta;backward+=Math.max(0,-delta);
    }
    if(turn<5.7||turn>TAU*1.98||backward>.8)continue;
    // Bearings come from where each tail meets the ring, not from the remote
    // stroke endpoints (a curved exit can point somewhere else entirely).
    let entry=start,exit=end;
    while(entry<i&&gap(points[entry],center)>radius*1.04)entry++;
    while(exit>j&&gap(points[exit],center)>radius*1.04)exit--;
    const entryAngle=angle(points[entry],center),exitAngle=angle(points[exit],center);
    const score=fit.error+fit.backward*.03+Math.abs(fit.turn-TAU)*.035;
    if(!best||score<best.score)best={score,center:{x:center.x/width,y:center.y/height},radius,entryAngle,exitAngle,relativeExitAngle:wrap(exitAngle-entryAngle),direction:fit.direction,loopStart:entry,loopEnd:exit,confidence:clamp(1-score*3,0,1)};
   }
  }
  if(!best)return null;delete best.score;return best;
 }
 function build(detection,options){
  const dimensions=size(options);if(!dimensions||!detection||!Number.isFinite(detection.relativeExitAngle))return [];
  const {width,height}=dimensions,minSize=Math.min(width,height),radius=minSize*.17,center={x:width*.5,y:height*.46};
  const normalize=p=>({x:p.x/width,y:p.y/height});
  const onRing=a=>({x:center.x+radius*Math.cos(a),y:center.y+radius*Math.sin(a)});
  const line=(a,b,part)=>({p:[a,mix(a,b,1/3),mix(a,b,2/3),b].map(normalize),route:true,part});
  const entry=Math.PI/2,direction=detection.direction===-1?-1:1;
  let exit=entry+wrap(detection.relativeExitAngle);
  let sweep=((direction*(exit-entry))%TAU+TAU)%TAU;
  // An exit at the entry arm still means a complete lap, not a zero-length arc.
  if(sweep<.035||TAU-sweep<.035){sweep=TAU;exit=entry}
  function arcs(start,amount,route){
   if(amount<1e-8)return [];
   const count=Math.ceil(amount/(Math.PI/2)),delta=direction*amount/count,result=[];
   for(let i=0;i<count;i++){
    const a=start+i*delta,b=a+delta,k=4/3*Math.tan(delta/4),first=onRing(a),last=onRing(b);
    const p=[first,{x:first.x-k*radius*Math.sin(a),y:first.y+k*radius*Math.cos(a)},{x:last.x+k*radius*Math.sin(b),y:last.y-k*radius*Math.cos(b)},last];
    result.push({p:p.map(normalize),route,part:'ring'});
   }
   return result;
  }
  const approach=line({x:center.x,y:height*.90},onRing(entry),'approach');
  const exitPoint={x:center.x+minSize*.34*Math.cos(exit),y:center.y+minSize*.34*Math.sin(exit)};
  return [approach,...arcs(entry,sweep,true),line(onRing(exit),exitPoint,'exit'),...arcs(entry+direction*sweep,TAU-sweep,false)];
 }
 return {detect,build};
});
