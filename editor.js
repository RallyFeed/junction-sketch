(() => {
'use strict';
const root=document.getElementById('tulip-thumb-flow'),find=s=>root.querySelector(s),svg=find('.tt-sketch'),paper=find('.tt-paper'),row=find('.tt-favourites'),NS='http://www.w3.org/2000/svg';
const GRID_SPACING=24;
root.style.setProperty('--tt-grid-spacing',`${GRID_SPACING}px`);
const types={
 house:{label:'House',icon:'house',kind:'point'},tree:{label:'Tree',icon:'tree-deciduous',kind:'point'},gate:{label:'Gate',icon:'fence',kind:'point'},
 bridge:{label:'Bridge',icon:'landmark',kind:'point'},sign:{label:'Sign',icon:'signpost',kind:'point'},pole:{label:'Pole',icon:'utility-pole',kind:'point'},rock:{label:'Rock',icon:'mountain',kind:'point'},church:{label:'Church',icon:'church',kind:'point'},
 hedge:{label:'Hedge',icon:'shrub',kind:'line',color:'#39764a'},bank:{label:'Sandbank',icon:'mountain',kind:'line',color:'#8c6b3d'},water:{label:'Waterline',icon:'waves',kind:'line',color:'#2575c4'},tower:{label:'Tower',icon:'tower-control',kind:'point'}
};
const copy=x=>JSON.parse(JSON.stringify(x)),dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const point=(p,t)=>{const a=lerp(p[0],p[1],t),b=lerp(p[1],p[2],t),c=lerp(p[2],p[3],t);return lerp(lerp(a,b,t),lerp(b,c,t),t)};
let roads=[],features=[],raw=[],history=[];
let selected=null,placement=null,gesture=null,ink=[],width=370,height=405,aspect=370/405,aspectLocked=false,nextId=0,quickTimer,pending=null;
let favourites=['house','hedge','bank','water'],managing=false,favouriteSlot=0;
const FAVOURITES_KEY='rallymaker.tulip.favourites.v1';
try{const stored=JSON.parse(localStorage.getItem(FAVOURITES_KEY));if(Array.isArray(stored)&&stored.length===4&&new Set(stored).size===4&&stored.every(t=>types[t]))favourites=stored}catch(_){}
const featureMeta=f=>({...types[f.type],label:f.label||types[f.type]?.label||'Landmark',icon:types[f.type]?.icon||'map-pin',kind:f.at?'point':'line'});
const getState=()=>({format:'spline-v2',aspect,roads:copy(roads),features:copy(features),raw:copy(raw)});
const changed=()=>root.dispatchEvent(new CustomEvent('sketchchange'));
const id=()=>{let candidate;do{candidate=`curve-${Date.now().toString(36)}-${++nextId}`}while([...roads,...features].some(item=>String(item.id)===candidate));return candidate};
const persistFavourites=()=>{try{localStorage.setItem(FAVOURITES_KEY,JSON.stringify(favourites))}catch(_){}};
const status=t=>find('.tt-message').textContent=t,buttons=()=>[...row.querySelectorAll('[data-feature]')];
const chosenRoad=()=>selected?.kind==='road'?roads.find(r=>r.id===selected.id):null;
const chosenFeature=()=>selected?.kind==='feature'?features.find(f=>f.id===selected.id):null;
const screenDistance=(a,b)=>Math.hypot((a.x-b.x)*width,(a.y-b.y)*height);
function save(){history.push(getState());if(history.length>40)history.shift()}
function element(tag,attrs){const n=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));return n}
function path(p,w=width,h=height){return `M${p[0].x*w} ${p[0].y*h} C${p[1].x*w} ${p[1].y*h} ${p[2].x*w} ${p[2].y*h} ${p[3].x*w} ${p[3].y*h}`}
function resolve(){
 const done=new Set(),visiting=new Set();
 function visit(r){
  if(done.has(r.id)||visiting.has(r.id))return;visiting.add(r.id);
  for(const [key,end,control] of [['attach',0,1],['endAttach',3,2]]){
   const attachment=r[key],parent=attachment&&roads.find(p=>p.id===attachment.id);
   if(!parent||visiting.has(parent.id))continue;visit(parent);
   const next=point(parent.p,attachment.t),dx=next.x-r.p[end].x,dy=next.y-r.p[end].y;
   r.p[end]=next;r.p[control].x+=dx;r.p[control].y+=dy;
  }
  visiting.delete(r.id);done.add(r.id);
 }
 roads.forEach(visit);
}
function frame(p,t,w=width,h=height){const q=point(p,t),a=point(p,Math.max(0,t-.002)),b=point(p,Math.min(1,t+.002)),dx=(b.x-a.x)*w,dy=(b.y-a.y)*h,l=Math.hypot(dx,dy)||1;return{x:q.x*w,y:q.y*h,nx:-dy/l,ny:dx/l}}
// These illustrative patterns are independent of road connectivity.
function drawLineFeature(f,color,target=svg,w=width,h=height){
 let length=0,last=point(f.p,0);for(let i=1;i<=40;i++){const q=point(f.p,i/40);length+=Math.hypot((q.x-last.x)*w,(q.y-last.y)*h);last=q}
 const common={fill:'none',stroke:color,'stroke-width':2.2,'stroke-linecap':'round','stroke-linejoin':'round'};
 if(f.type==='bank'||f.type==='fence'){
  target.append(element('path',{d:path(f.p,w,h),...common}));const count=Math.max(2,Math.round(length/13)),side=f.side||1;let d='';
  for(let i=0;i<=count;i++){const q=frame(f.p,i/count,w,h);d+=f.type==='fence'?`M${q.x-q.nx*4} ${q.y-q.ny*4} l${q.nx*8} ${q.ny*8} `:`M${q.x} ${q.y} l${q.nx*8*side} ${q.ny*8*side} `}target.append(element('path',{d,...common,'stroke-width':1.8}));
 }else{
  const count=Math.max(2,Math.round(length/(f.type==='hedge'?15:22))),samples=Math.max(24,count*14);let d='';
  for(let i=0;i<=samples;i++){const t=i/samples,q=frame(f.p,t,w,h),offset=f.type==='hedge'?-5*Math.abs(Math.sin(t*count*Math.PI)):3.5*Math.sin(t*count*Math.PI*2);d+=`${i?'L':'M'}${q.x+q.nx*offset} ${q.y+q.ny*offset} `}target.append(element('path',{d,...common}));
 }
}
function drawPointFeature(f,color){
 const holder=element('foreignObject',{x:f.at.x*width-14,y:f.at.y*height-14,width:28,height:28,'pointer-events':'none'}),wrap=document.createElementNS('http://www.w3.org/1999/xhtml','div'),icon=document.createElementNS('http://www.w3.org/1999/xhtml','i');
 wrap.setAttribute('class','tt-mark-icon');wrap.setAttribute('style',`width:28px;height:28px;display:flex;align-items:center;justify-content:center;color:${color}`);icon.setAttribute('data-lucide',featureMeta(f).icon);icon.setAttribute('style','width:25px;height:25px;stroke-width:2');icon.setAttribute('aria-hidden','true');wrap.append(icon);holder.append(wrap);svg.append(holder);
}
function hideQuick(){clearTimeout(quickTimer);find('.tt-quick').hidden=true}
function syncControls(){
 const road=chosenRoad(),feature=chosenFeature();find('.tt-context').hidden=!road;find('.tt-feature-context').hidden=!feature;find('.tt-landmarks').hidden=!!selected;
 find('.tt-pen').setAttribute('aria-pressed',String(!selected&&!placement&&find('.tt-picker').hidden));find('.tt-undo').disabled=!history.length;find('.tt-clear').disabled=!roads.length&&!features.length;
 for(const b of root.querySelectorAll('[data-surface]'))b.setAttribute('aria-pressed',String(road?.type===b.dataset.surface));
 for(const b of buttons())b.setAttribute('aria-pressed',String(placement===b.dataset.feature));
 if(feature){find('.tt-feature-label').textContent=feature.label||featureMeta(feature).label;find('.tt-flip').hidden=feature.type!=='bank'||!feature.p}
 if(selected||!find('.tt-picker').hidden)hideQuick();
}
function draw(){
 svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
 for(const r of roads)svg.append(element('path',{d:path(r.p),fill:'none',stroke:chosenRoad()===r?'#245fce':'#12243f','stroke-width':r.route?7:3.5,'stroke-linecap':'round','stroke-linejoin':'round','stroke-dasharray':r.type==='gravel'?'11 8':r.type==='track'?'1 8':'none'}));
 const routePieces=roads.filter(r=>r.route),first=routePieces[0],last=routePieces.at(-1);if(first){const a=first.p[0],[,,q,z]=last.p,ang=Math.atan2((z.y-q.y)*height,(z.x-q.x)*width);svg.append(element('circle',{cx:a.x*width,cy:a.y*height,r:9,fill:'#12243f'}));svg.append(element('path',{d:`M${z.x*width-14*Math.cos(ang-.55)} ${z.y*height-14*Math.sin(ang-.55)} L${z.x*width} ${z.y*height} L${z.x*width-14*Math.cos(ang+.55)} ${z.y*height-14*Math.sin(ang+.55)}`,fill:'none',stroke:'#12243f','stroke-width':6,'stroke-linecap':'round','stroke-linejoin':'round'}))}
 for(const f of features){const color=types[f.type]?.color||(chosenFeature()===f?'#245fce':'#12243f');if(featureMeta(f).kind==='point')drawPointFeature(f,color);else drawLineFeature(f,color)}
 if(ink.length>1)svg.append(element('polyline',{points:ink.map(p=>`${p.x*width},${p.y*height}`).join(' '),fill:'none',stroke:types[placement]?.color||'#245fce','stroke-width':3,opacity:.6,'stroke-linecap':'round'}));
 const chosen=chosenRoad()||chosenFeature();if(chosen){const handles=chosen.at?[chosen.at]:[0,.5,1].map(t=>point(chosen.p,t));for(const p of handles){svg.append(element('circle',{cx:p.x*width,cy:p.y*height,r:18,fill:'#245fce15'}));svg.append(element('circle',{cx:p.x*width,cy:p.y*height,r:chosen.at?16:7,fill:chosen.at?'none':'#fff',stroke:'#245fce','stroke-width':2}))}}
 syncControls();if(features.some(f=>featureMeta(f).kind==='point')&&globalThis.lucide?.createIcons)globalThis.lucide.createIcons({attrs:{width:22,height:22}});
}
function quick(label){clearTimeout(quickTimer);find('.tt-quick span').textContent=label;find('.tt-quick').hidden=!!selected||!find('.tt-picker').hidden;quickTimer=setTimeout(()=>{find('.tt-quick').hidden=true},4000)}
function closeSheet(){find('.tt-add').hidden=true;find('.tt-more').setAttribute('aria-expanded','false')}
function closePicker(){find('.tt-picker').hidden=true;find('.tt-arrange').setAttribute('aria-expanded','false');managing=false;find('.tt-picker-manage').setAttribute('aria-pressed','false')}
function dismiss(){commitPending();selected=null;placement=null;closePicker();closeSheet();hideQuick();draw()}
function undo(){commitPending();if(!history.length)return;const last=history.pop();roads=last.roads;features=last.features;raw=last.raw||[];gesture=null;ink=[];aspect=last.aspect||aspect;aspectLocked=!!(roads.length||features.length||raw.length);measure();dismiss();status('Undone. Keep drawing.');changed()}
function measure(){
 const r=paper.getBoundingClientRect();if(!r.width||!r.height)return;
 // Fresh paper uses every visible dot. Once ink exists, its proportions stay fixed.
 if(!aspectLocked&&!gesture&&!pending)aspect=Math.max(.25,Math.min(4,r.width/r.height));
 width=Math.min(r.width,r.height*aspect);height=width/aspect;
 root.style.setProperty('--sketch-aspect',String(aspect));
 Object.assign(svg.style,{position:'absolute',width:`${width}px`,height:`${height}px`,left:`${(r.width-width)/2}px`,top:`${(r.height-height)/2}px`});
}
function pos(e){const r=svg.getBoundingClientRect();return{x:Math.max(.015,Math.min(.985,(e.clientX-r.left-(r.width-width)/2)/width)),y:Math.max(.015,Math.min(.985,(e.clientY-r.top-(r.height-height)/2)/height))}}
function curveHit(r,p){
 let t=0,d=Infinity;for(let i=0;i<=64;i++){const candidate=i/64,gap=screenDistance(point(r.p,candidate),p);if(gap<d){d=gap;t=candidate}}
 let lo=Math.max(0,t-1/64),hi=Math.min(1,t+1/64);
 for(let i=0;i<18;i++){const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;if(screenDistance(point(r.p,a),p)<screenDistance(point(r.p,b),p))hi=b;else lo=a}
 t=(lo+hi)/2;let q=point(r.p,t);d=screenDistance(q,p);
 for(const end of [0,1]){const ep=point(r.p,end),gap=screenDistance(ep,p);if(gap<d){t=end;q=ep;d=gap}}
 return{kind:'road',id:r.id,r,q,t,d};
}
function nearRoad(p){let best=null;for(const r of roads){const hit=curveHit(r,p);if(!best||hit.d<best.d)best=hit}return best&&best.d<28?best:null}
function nearest(p){let best=nearRoad(p);for(const f of features){const samples=f.at?[f.at]:Array.from({length:101},(_,i)=>point(f.p,i/100));for(const q of samples){const d=screenDistance(q,p);if(d<28&&(!best||d<best.d))best={kind:'feature',id:f.id,d}}}return best}
function handle(p){const r=chosenRoad()||chosenFeature();if(!r)return null;let best=null;for(const t of r.at?[0]:[0,.5,1]){const q=r.at||point(r.p,t),d=screenDistance(q,p);if(d<22&&(!best||d<best.d))best={r,kind:selected.kind,t,d}}return best}
// A connection moves the shared junction, without borrowing the parent road's tangent.
function moveCurveAt(r,t,dx,dy,visited=new Set()){
 if(visited.has(r.id))return;visited.add(r.id);
 const key=t===0?'attach':t===1?'endAttach':null,attachment=key&&r[key],parent=attachment&&roads.find(k=>k.id===attachment.id);
 if(parent){moveCurveAt(parent,attachment.t,dx,dy,visited);return}
 if(t===0||t===1){for(const i of t===0?[0,1]:[3,2]){r.p[i].x+=dx;r.p[i].y+=dy}return}
 const u=1-t,A=3*u*u*t,B=3*u*t*t,den=A*A+B*B;
 if(den>.000001){r.p[1].x+=dx*A/den;r.p[1].y+=dy*A/den;r.p[2].x+=dx*B/den;r.p[2].y+=dy*B/den}
}
function moveHandle(h,dx,dy){
 const {r,t}=h;if(r.at){r.at.x+=dx;r.at.y+=dy;return}
 moveCurveAt(r,t,dx,dy);if(h.kind==='road')resolve();
}
function straightCurve(a,d){return[copy(a),lerp(a,d,1/3),lerp(a,d,2/3),copy(d)]}
function straightStroke(points){
 const a=points[0],d=points.at(-1),dx=(d.x-a.x)*width,dy=(d.y-a.y)*height,chord=Math.hypot(dx,dy);
 // Use one visible dot-column width, aligned with the direction of the stroke.
 if(chord<GRID_SPACING)return false;
 let low=0,high=0,furthest=0;
 for(const q of points){
  const x=(q.x-a.x)*width,y=(q.y-a.y)*height,along=(x*dx+y*dy)/chord,across=(x*dy-y*dx)/chord;
  low=Math.min(low,across);high=Math.max(high,across);
  if(high-low>GRID_SPACING+1e-6)return false;
  // Ignore tiny finger jitter, but a deliberate reversal keeps the drawn curve.
  if(along<furthest-2-1e-6)return false;
  furthest=Math.max(furthest,along);
 }
 return true;
}
function fit(points,start,end){
 const a=points[0],d=points[points.length-1];
 // Rebuild assisted controls AFTER snapping so the final road stays straight.
 if(straightStroke(points))return straightCurve(start||a,end||d);
 const lens=[0];for(let i=1;i<points.length;i++)lens.push(lens[i-1]+screenDistance(points[i-1],points[i]));
 const length=lens.at(-1)||1;let aa=0,ab=0,bb=0,ax=0,ay=0,bx=0,by=0;
 points.forEach((p,i)=>{const t=lens[i]/length,u=1-t,A=3*u*u*t,B=3*u*t*t,x=p.x-u*u*u*a.x-t*t*t*d.x,y=p.y-u*u*u*a.y-t*t*t*d.y;aa+=A*A;ab+=A*B;bb+=B*B;ax+=A*x;ay+=A*y;bx+=B*x;by+=B*y});
 const det=aa*bb-ab*ab;
 const clamp=p=>({x:Math.max(-.25,Math.min(1.25,p.x)),y:Math.max(-.25,Math.min(1.25,p.y))});
 const p=Math.abs(det)<1e-8?straightCurve(a,d):[copy(a),clamp({x:(ax*bb-bx*ab)/det,y:(ay*bb-by*ab)/det}),clamp({x:(bx*aa-ax*ab)/det,y:(by*aa-ay*ab)/det}),copy(d)];
 for(const [q,index,control] of [[start,0,1],[end,3,2]])if(q){const dx=q.x-p[index].x,dy=q.y-p[index].y;p[index]=copy(q);p[control].x+=dx;p[control].y+=dy}
 return p;
}
function commitStroke(g,points){
 if(points.length<2)return;save();raw.push(copy(points));
 if(g.placement){features.push({id:id(),type:g.placement,p:fit(points),side:1});placement=null;status(`${types[g.placement].label} drawn. Back to Pen.`);quick(`${types[g.placement].label} added`)}
 else{
  const start=nearRoad(points[0]);let end=nearRoad(points.at(-1));
  // A short fork can leave the same road's snap margin without reaching its edge.
  // Keep its free end instead of snapping both ends onto one junction.
  if(start&&end&&screenDistance(start.q,end.q)<4&&straightStroke(points))end=null;
  const p=fit(points,start?.q,end?.q),road={id:id(),route:!roads.some(r=>r.route),type:'tarmac',p};
  for(const [hit,key] of [[start,'attach'],[end,'endAttach']])if(hit)road[key]={id:hit.id,t:hit.t};
  roads.push(road);status('Tap a road or landmark to edit.');quick(start||end?'Fork added':'Road added');
 }
 selected=null;ink=[];draw();changed();
}
function commitPending(){
 if(!pending)return;const saved=pending;pending=null;clearTimeout(saved.timer);commitStroke(saved.g,saved.points);
}
function deferStroke(g,points){
 pending={g,points:copy(points),timer:setTimeout(commitPending,280)};ink=copy(points);draw();
}
svg.addEventListener('pointerdown',e=>{
 if(gesture||e.isPrimary===false)return;e.preventDefault();svg.setPointerCapture(e.pointerId);
 measure();aspectLocked=true;
 const p=pos(e);let resume=null;
 if(pending&&pending.g.placement===placement&&screenDistance(p,pending.points.at(-1))<=18){resume=pending;clearTimeout(pending.timer);pending=null}else commitPending();
 closeSheet();closePicker();
 gesture={id:e.pointerId,start:p,last:p,handle:placement?null:handle(p),hit:nearest(p),moved:false,placement,resume};
 ink=resume?copy(resume.points):placement&&types[placement].kind==='point'?[]:[p];hideQuick();syncControls();
});
function move(e){
 if(!gesture||gesture.id!==e.pointerId)return;const p=pos(e),g=gesture;
 if(!g.moved&&screenDistance(p,g.start)<7)return;
 if(!g.moved){
  g.moved=true;
  if(g.resume){g.handle=null;g.placement=g.resume.g.placement;g.start=g.resume.g.start;selected=null}
  else if(g.handle){g.before=getState();save()}else selected=null;
 }
 if(g.handle){moveHandle(g.handle,p.x-g.last.x,p.y-g.last.y);ink=[]}
 else if(!g.placement||types[g.placement].kind==='line'){
  if(!ink.length||screenDistance(p,ink.at(-1))>.4)ink.push(p);
  if(ink.length>6000)ink=ink.filter((_,i)=>i===0||i===ink.length-1||i%2===0);
 }
 g.last=p;draw();
}
svg.addEventListener('pointermove',move);
function finish(e){
 if(!gesture||gesture.id!==e.pointerId)return;move(e);const g=gesture;gesture=null;if(svg.hasPointerCapture?.(e.pointerId))svg.releasePointerCapture(e.pointerId);
 // A tap after lifting remains a selection gesture; only actual movement resumes ink.
 if(g.resume&&!g.moved){commitStroke(g.resume.g,g.resume.points);g.hit=nearest(pos(e))}
 if(g.placement&&types[g.placement].kind==='point'){
  save();features.push({id:id(),type:g.placement,at:pos(e)});placement=null;status(`${types[g.placement].label} placed. Back to Pen.`);quick(`${types[g.placement].label} added`);ink=[];draw();changed();return;
 }
 if(g.moved&&g.handle){status(g.handle.r.at?'Landmark moved.':'Curve adjusted.');quick(g.handle.r.at?'Landmark moved':'Curve adjusted');ink=[];draw();changed();return}
 if(g.moved&&ink.length>1){const p=pos(e);if(screenDistance(ink.at(-1),p)>.01)ink.push(p);selected=null;deferStroke(g,ink);return}
 if(g.placement)status(`Draw a line for ${types[g.placement].label.toLowerCase()}.`);
 else{selected=g.hit?{kind:g.hit.kind,id:g.hit.id}:null;status(selected?'Drag a handle. Tap empty canvas to return to Pen.':'Draw your route. Tap a road to edit.')}
 ink=[];if(!roads.length&&!features.length&&!raw.length){aspectLocked=false;measure()}draw();
}
svg.addEventListener('pointerup',finish);
paper.addEventListener('pointerdown',e=>{if(e.target===paper&&!gesture){dismiss();status('Draw your route. Tap a road to edit.')}});
svg.addEventListener('pointercancel',e=>{
 if(gesture?.id!==e.pointerId)return;const g=gesture;gesture=null;
 if(g.before){roads=g.before.roads;features=g.before.features;raw=g.before.raw;history.pop();status('Adjustment cancelled.')}
 else if(g.moved&&ink.length>1){commitStroke(g,ink)}
 else if(g.resume)commitStroke(g.resume.g,g.resume.points);
 ink=[];if(!roads.length&&!features.length&&!raw.length){aspectLocked=false;measure()}draw();
});
find('.tt-pen').onclick=()=>{dismiss();status('Draw your route. Tap a road to edit.')};find('.tt-undo').onclick=undo;find('.tt-quick').onclick=undo;
find('.tt-delete').onclick=()=>{
 commitPending();const r=chosenRoad();if(!r)return;save();roads=roads.filter(k=>k.id!==r.id);
 for(const k of roads){if(k.attach?.id===r.id)delete k.attach;if(k.endAttach?.id===r.id)delete k.endAttach}
 if(roads.length&&!roads.some(k=>k.route))roads[0].route=true;
 dismiss();status('Road deleted.');quick('Road deleted');changed();
};
find('.tt-feature-delete').onclick=()=>{commitPending();const f=chosenFeature();if(!f)return;save();features=features.filter(k=>k.id!==f.id);dismiss();status(`${featureMeta(f).label} deleted.`);quick('Landmark deleted');changed()};
find('.tt-flip').onclick=()=>{commitPending();const f=chosenFeature();if(!f||f.type!=='bank')return;save();f.side=-(f.side||1);draw();status('Sandbank marks flipped to the other side.');changed()};
find('.tt-clear').onclick=()=>{commitPending();if(!roads.length&&!features.length)return;save();roads=[];features=[];ink=[];gesture=null;dismiss();status('Sketch cleared. Your note stays.');quick('Sketch cleared');changed()};
find('.tt-more').onclick=()=>{const show=find('.tt-add').hidden;dismiss();find('.tt-add').hidden=!show;find('.tt-more').setAttribute('aria-expanded',String(show))};find('.tt-close').onclick=dismiss;
find('.tt-done').onclick=()=>{dismiss();root.dispatchEvent(new CustomEvent('finishpoint'))};
for(const b of root.querySelectorAll('[data-surface]'))b.onclick=()=>{commitPending();const r=chosenRoad();if(!r||r.type===b.dataset.surface)return;save();r.type=b.dataset.surface;draw();status('Surface updated.');changed()};
function icons(){if(globalThis.lucide?.createIcons)globalThis.lucide.createIcons({attrs:{width:22,height:22}})}
function featureButton(type,className){
 const b=document.createElement('button');b.type='button';b.className=className;b.dataset.feature=type;
 let icon;
 if(types[type].kind==='line'){
  icon=element('svg',{class:'tt-feature-sample',viewBox:'0 0 42 26',width:42,height:26,'aria-hidden':'true'});
  drawLineFeature({type,side:1,p:[{x:.12,y:.62},{x:.36,y:.62},{x:.64,y:.36},{x:.88,y:.36}]},types[type].color||'currentColor',icon,42,26);
 }else{icon=document.createElement('i');icon.setAttribute('data-lucide',types[type].icon);icon.setAttribute('aria-hidden','true')}
 const label=document.createElement('span');label.textContent=types[type].label;b.append(icon,label);return b;
}
function arm(type){const wasActive=placement===type;dismiss();placement=wasActive?null:type;status(placement?types[type].kind==='point'?`Tap the sketch to place ${types[type].label.toLowerCase()}.`:`Draw ${types[type].label.toLowerCase()} with one stroke.`:'Back to Pen.');draw()}
function renderFavourites(){
 row.replaceChildren();for(const type of favourites){const b=featureButton(type,'tt-favourite');b.onclick=()=>arm(type);row.append(b)}icons();syncControls();persistFavourites();
}
function renderPicker(){
 const slots=find('.tt-picker-favourites');slots.replaceChildren();
 favourites.forEach((type,i)=>{const b=featureButton(type,'tt-picker-slot');b.setAttribute('aria-label',`Favourite ${i+1}: ${types[type].label}`);b.classList.toggle('is-selected',managing&&i===favouriteSlot);b.setAttribute('aria-pressed',String(managing&&i===favouriteSlot));b.onclick=()=>{if(managing){favouriteSlot=i;renderPicker()}else arm(type)};slots.append(b)});
 find('.tt-picker-manage').setAttribute('aria-pressed',String(managing));find('.tt-picker-manage').textContent=managing?'Done':'Edit';find('.tt-reorder-bar').hidden=!managing;find('.tt-reorder-label').textContent=`${favouriteSlot+1} · ${types[favourites[favouriteSlot]].label}`;
 find('.tt-order-left').hidden=!managing;find('.tt-order-right').hidden=!managing;
 find('.tt-order-left').disabled=favouriteSlot===0;find('.tt-order-right').disabled=favouriteSlot===favourites.length-1;
 find('.tt-picker-hint').textContent=managing?'Tap a slot, then choose its replacement.':'All landmarks';
 const query=find('.tt-landmark-search').value.trim().toLowerCase(),results=find('.tt-picker-results');results.replaceChildren();
 for(const [type,meta] of Object.entries(types)){
  const keywords=`${meta.label} ${type} ${meta.kind} ${type==='bank'?'sand bank embankment berm':type==='water'?'water line river shore':type==='pole'?'utility electric power':''}`.toLowerCase();if(query&&!keywords.includes(query))continue;
  const b=featureButton(type,'tt-library-item');b.setAttribute('aria-label',`${meta.label}, ${meta.kind==='line'?'draw a line':'place symbol'}`);
  b.onclick=()=>{
   if(!managing){arm(type);return}
   const existing=favourites.indexOf(type),old=favourites[favouriteSlot];
   if(existing>=0)favourites[existing]=old;favourites[favouriteSlot]=type;
   renderFavourites();renderPicker();status(`${meta.label} is favourite ${favouriteSlot+1}.`);
  };results.append(b);
 }
 if(!results.children.length){const message=document.createElement('p');message.textContent='No landmarks match. Try another name.';results.append(message)}icons();
}
function moveFavourite(direction){const target=favouriteSlot+direction;if(target<0||target>=favourites.length)return;[favourites[favouriteSlot],favourites[target]]=[favourites[target],favourites[favouriteSlot]];favouriteSlot=target;renderFavourites();renderPicker()}
find('.tt-arrange').onclick=()=>{dismiss();find('.tt-picker').hidden=false;find('.tt-arrange').setAttribute('aria-expanded','true');find('.tt-landmark-search').value='';renderPicker();syncControls()};
find('.tt-picker-close').onclick=()=>{closePicker();draw()};
find('.tt-picker-manage').onclick=()=>{managing=!managing;renderPicker()};
find('.tt-landmark-search').oninput=renderPicker;
find('.tt-order-left').onclick=()=>moveFavourite(-1);find('.tt-order-right').onclick=()=>moveFavourite(1);
function setState(state){
 if(pending)clearTimeout(pending.timer);pending=null;gesture=null;ink=[];
 roads=copy(state?.roads||[]);features=copy(state?.features||[]);raw=copy(state?.raw||[]);
 aspect=Number.isFinite(state?.aspect)&&state.aspect>=.25&&state.aspect<=4?state.aspect:370/405;
 aspectLocked=!!(roads.length||features.length||raw.length);
 root.style.setProperty('--sketch-aspect',String(aspect));measure();
 if(roads.length&&!roads.some(r=>r.route))roads[0].route=true;
 history=[];selected=null;placement=null;closePicker();closeSheet();hideQuick();draw();
 status(roads.length||features.length?'Tap a road or landmark to edit.':'Draw your route. Tap a road to edit.');
}
function exportSVG(){
 commitPending();const previousSelection=selected,previousInk=ink;selected=null;ink=[];draw();
 const result=svg.cloneNode(true);selected=previousSelection;ink=previousInk;draw();
 result.removeAttribute('style');result.removeAttribute('class');
 result.setAttribute('xmlns',NS);result.setAttribute('width',width);result.setAttribute('height',height);result.setAttribute('color','#12243f');result.setAttribute('aria-label','Roadbook tulip');
 for(const holder of result.querySelectorAll('foreignObject')){
  const source=holder.querySelector('svg'),nested=element('svg',{x:holder.getAttribute('x'),y:holder.getAttribute('y'),width:28,height:28,viewBox:source?.getAttribute('viewBox')||'0 0 24 24',fill:'none',stroke:'#12243f','stroke-width':2,'stroke-linecap':'round','stroke-linejoin':'round'});
  if(source)for(const child of source.children)nested.append(child.cloneNode(true));
  else nested.append(element('circle',{cx:12,cy:12,r:6}));
  holder.replaceWith(nested);
 }
 return new XMLSerializer().serializeToString(result);
}
globalThis.TulipEditor={getState,setState,clearHistory(){history=[];hideQuick();syncControls()},hasContent(){return !!(roads.length||features.length||raw.length||pending)},commitPending,render:draw,exportSVG};
renderFavourites();
new ResizeObserver(()=>{measure();draw()}).observe(paper);measure();hideQuick();draw();status('Draw your route. Tap a road to edit.');
})();
